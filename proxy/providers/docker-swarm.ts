import type { CityMeta, LivenessStatus, MetricSnapshot, ProviderCapability } from "../protocol.ts";
import { BaseProvider } from "./base.ts";
import { DockerClient } from "./docker-api.ts";
import { makeLogSource } from "./logsources/index.ts";
import {
  buildMetaBatch,
  groupTasksIntoTopology,
  type MetaLogState,
  parseList,
} from "./swarm/infer.ts";
import { buildLogTargets, createLogCollector } from "./swarm/logs.ts";
import type { SwarmNode, SwarmService, SwarmTask, TopologyEntry } from "./swarm/types.ts";
import { bytesToMb, nanoToCores, round } from "./units.ts";

// ── State ──

const docker = new DockerClient();
let topology: TopologyEntry[] = [];
let cityMeta: Record<string, CityMeta> = {};
const logSource = makeLogSource(docker);

/**
 * `AMBIENT_SERVICES` complements the `confcity.ambient` label for services whose
 * stack file is not at hand: same effect, configured on this provider instead.
 */
const ambientFromEnv = new Set(parseList(process.env.AMBIENT_SERVICES));
const metaLogged: MetaLogState = { hubs: "", ambient: "" };

// ── Topology refresh ──

async function refreshTopology() {
  try {
    const runningFilter = encodeURIComponent(JSON.stringify({ "desired-state": ["running"] }));
    const [nodes, services, tasks] = await Promise.all([
      docker.get<SwarmNode[]>("/nodes"),
      docker.get<SwarmService[]>("/services"),
      docker.get<SwarmTask[]>(`/tasks?filters=${runningFilter}`),
    ]);

    const hostnameOf = new Map<string, string>();
    const nextCityMeta: Record<string, CityMeta> = {};
    for (const n of nodes) {
      hostnameOf.set(n.ID, n.Description.Hostname);
      const r = n.Description.Resources;
      nextCityMeta[n.Description.Hostname] = {
        label: n.Description.Hostname,
        cpuCores: r?.NanoCPUs ? nanoToCores(r.NanoCPUs) : undefined,
        memMb: r?.MemoryBytes ? Math.round(bytesToMb(r.MemoryBytes)) : undefined,
        biome: n.Spec.Labels?.["confcity.biome"],
      };
    }
    cityMeta = nextCityMeta;

    const serviceOf = new Map<string, SwarmService>();
    for (const s of services) {
      serviceOf.set(s.ID, s);
    }

    topology = groupTasksIntoTopology(tasks, hostnameOf, serviceOf);
    const cityCount = new Set(topology.map((t) => t.cityId)).size;
    console.log(`[swarm] Topology: ${topology.length} service instances across ${cityCount} nodes`);

    // Send node metadata so frontend knows types, labels, groups and links
    if (provider.connected) {
      provider.sendNodeMeta(buildMetaBatch(topology, ambientFromEnv, metaLogged), cityMeta);
    }
  } catch (err) {
    console.error("[swarm] Failed to refresh topology:", err);
  }
}

// ── Metrics (resource limits) ──
// Usage (cpu, memoryMb, net) is NOT collected here: /containers/{id}/stats only answers
// for containers of the local daemon, so a manager-side provider is blind to every task
// scheduled on another node. The `docker-node.ts` agent (mode: global) reports usage for
// the containers it can see; the proxy merges both into the same address, and the two
// providers write disjoint fields (see TelemetryStore.applyMetrics).
//
// Limits stay here because they come from the service spec, which only the manager can
// read — and the spec is richer than the cgroup: it exposes Reservations as a fallback
// when no hard limit is set.

function collectMetrics(): Record<string, MetricSnapshot> | null {
  const topo = topology; // snapshot to avoid mid-iteration mutation
  if (topo.length === 0) {
    return null;
  }

  const out: Record<string, MetricSnapshot> = {};

  for (const entry of topo) {
    const address = `${entry.cityId}/${entry.nodeId}`;
    const snap: MetricSnapshot = {};
    // Per-replica limits scaled by the replicas running on that node, so they line up
    // with the usage the node agent sums over those same replicas.
    const replicas = entry.containerIds.length;
    if (replicas > 0) {
      if (entry.cpuLimit) {
        snap.cpuLimit = round(entry.cpuLimit * replicas, 2);
      }
      if (entry.memLimitMb) {
        snap.memLimitMb = entry.memLimitMb * replicas;
      }
    }
    out[address] = snap;
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ── Liveness (derived from task states) ──

function collectLiveness(): Record<string, LivenessStatus> | null {
  const topo = topology;
  if (topo.length === 0) {
    return null;
  }

  const out: Record<string, LivenessStatus> = {};

  for (const entry of topo) {
    const address = `${entry.cityId}/${entry.nodeId}`;
    const { taskStates } = entry;

    if (taskStates.length === 0) {
      out[address] = "unknown";
      continue;
    }

    const running = taskStates.filter((s) => s === "running").length;
    const failed = taskStates.filter((s) => s === "failed" || s === "rejected").length;

    if (running === taskStates.length) {
      out[address] = "healthy";
    } else if (running > 0) {
      out[address] = "degraded";
    } else if (failed > 0) {
      out[address] = "down";
    } else {
      out[address] = "unknown";
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ── Logs ──

const collectLogs = createLogCollector(logSource, () => topology);

// ── Main ──

const capabilities: ProviderCapability[] = ["metrics", "liveness", "logs"];
// Only a real log store can serve a past window; the Docker API just tails.
if (logSource.supportsHistory) {
  capabilities.push("logs-query");
}

const metricsMs = Number(process.env.SWARM_METRICS_INTERVAL) || 5_000;
const livenessMs = Number(process.env.SWARM_LIVENESS_INTERVAL) || 5_000;
const logsMs = Number(process.env.SWARM_LOGS_INTERVAL) || 3_000;

const provider = new BaseProvider({
  id: process.env.PROVIDER_ID ?? "swarm-provider",
  type: "docker-swarm",
  capabilities,
  intervals: {
    metrics: { ms: metricsMs, collect: collectMetrics },
    liveness: { ms: livenessMs, collect: collectLiveness },
    logs: { ms: logsMs, collect: collectLogs },
  },
  onQueryLogs: logSource.supportsHistory
    ? async (q) => {
        const targets = buildLogTargets(topology, q.nodes);
        if (targets.length === 0) {
          return [];
        }
        return logSource.fetch({
          targets,
          since: q.since,
          until: q.until,
          limit: q.limit,
        });
      }
    : undefined,
});

console.log(`[swarm] Log backend: ${logSource.kind}`);

// Initial topology load (non-fatal on failure — loops will retry)
await refreshTopology().catch((err) => {
  console.warn("[swarm] Initial topology load failed, will retry:", err);
});

// Periodic topology refresh
const topoMs = Number(process.env.SWARM_TOPOLOGY_INTERVAL) || 30_000;
const topoTimer = setInterval(() => refreshTopology(), topoMs);

provider.stopOnSignals("swarm", () => clearInterval(topoTimer));
provider.start();

console.log("[swarm] Provider started");
