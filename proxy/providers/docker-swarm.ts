import { logKey } from "../logKey.ts";
import type {
  CityMeta,
  LivenessStatus,
  LogEntry,
  MetricSnapshot,
  NodeMeta,
  ProviderCapability,
} from "../protocol.ts";
import { BaseProvider } from "./base.ts";
import { DockerClient } from "./docker-api.ts";
import type { LogTarget } from "./logsources/index.ts";
import { makeLogSource } from "./logsources/index.ts";

// ── Docker Swarm API types ──

interface SwarmNode {
  ID: string;
  Description: {
    Hostname: string;
    Resources: { NanoCPUs: number; MemoryBytes: number };
  };
  Status: { State: string; Addr: string };
  Spec: { Role: string; Labels: Record<string, string> };
}

interface SwarmService {
  ID: string;
  Spec: {
    Name: string;
    Labels: Record<string, string>;
    TaskTemplate: {
      ContainerSpec: {
        Image: string;
        Labels?: Record<string, string>;
        Env?: string[];
      };
      Resources?: {
        Limits?: { NanoCPUs?: number; MemoryBytes?: number };
        Reservations?: { NanoCPUs?: number; MemoryBytes?: number };
      };
      Networks?: { Target: string }[];
    };
  };
}

interface SwarmTask {
  ID: string;
  ServiceID: string;
  NodeID: string;
  Status: {
    State: string;
    Timestamp: string;
    ContainerStatus?: { ContainerID: string };
    Message?: string;
    Err?: string;
  };
  DesiredState: string;
  Slot?: number;
}

// ── Helpers ──

/** Infer a Conf City node type from Docker image name and labels. */
function inferNodeType(image: string, labels: Record<string, string>): string {
  if (labels["confcity.type"]) {
    return labels["confcity.type"];
  }

  const img = image.toLowerCase();
  if (
    /postgres|mysql|mariadb|mongo|clickhouse|cockroach|cassandra|couchdb|influx|timescale/.test(img)
  ) {
    return "db";
  }
  if (/redis|memcache|varnish|hazelcast/.test(img)) {
    return "cache";
  }
  if (/rabbit|kafka|nats|pulsar|activemq|celery|bull/.test(img)) {
    return "queue";
  }
  return "app";
}

// ── Topology snapshot ──

interface TopologyEntry {
  cityId: string;
  nodeId: string;
  type: string;
  label: string;
  description?: string;
  group?: string;
  hidden: boolean;
  /** Internet entry point (`confcity.ingress`): the service becomes the island's port. */
  ingress: boolean;
  /** Ambient infrastructure (`confcity.ambient`): no link pointing at it is ever drawn. */
  ambient: boolean;
  /** Service names declared via `confcity.links` (resolved to addresses at meta time). */
  linkServices: string[];
  /** The label was present, even empty — inference is disabled for this service. */
  explicitLinks: boolean;
  /** Service names guessed from env vars (used only when no explicit links). */
  inferredLinkServices: string[];
  cpuLimit?: number; // cores
  memLimitMb?: number;
  serviceId: string;
  /** Swarm node id — what log stores carry in `com.docker.swarm.node.id`. */
  swarmNodeId: string;
  containerIds: string[];
  taskStates: string[];
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseBool(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Guess dependencies from env values that mention another service name (host part of URLs, HOST vars…). */
function inferLinksFromEnv(
  env: string[] | undefined,
  serviceNames: Set<string>,
  self: string,
): string[] {
  if (!env || env.length === 0) {
    return [];
  }
  const found = new Set<string>();
  for (const kv of env) {
    const eq = kv.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const value = kv.slice(eq + 1);
    const tokens = value.split(/[^A-Za-z0-9_.-]+/);
    for (const raw of tokens) {
      const token = raw.replace(/\.$/, "");
      if (token && token !== self && serviceNames.has(token)) {
        found.add(token);
      }
    }
  }
  return [...found];
}

// ── State ──

const docker = new DockerClient();
let topology: TopologyEntry[] = [];
let cityMeta: Record<string, CityMeta> = {};
const logSource = makeLogSource(docker);

// ── Topology refresh ──

/** Group running Swarm tasks into TopologyEntries keyed by (node, service). */
function groupTasksIntoTopology(
  tasks: SwarmTask[],
  hostnameOf: Map<string, string>,
  serviceOf: Map<string, SwarmService>,
): TopologyEntry[] {
  const skipStates = new Set(["complete", "orphaned", "remove"]);
  const groups = new Map<string, TopologyEntry>();
  const serviceNames = new Set([...serviceOf.values()].map((s) => s.Spec.Name));

  for (const task of tasks) {
    if (!task.NodeID || skipStates.has(task.Status.State)) {
      continue;
    }

    const hostname = hostnameOf.get(task.NodeID);
    const svc = serviceOf.get(task.ServiceID);
    if (!hostname || !svc) {
      continue;
    }

    const key = `${task.NodeID}::${task.ServiceID}`;

    if (!groups.has(key)) {
      const image = svc.Spec.TaskTemplate.ContainerSpec.Image;
      const labels = { ...svc.Spec.Labels, ...svc.Spec.TaskTemplate.ContainerSpec.Labels };
      const res = svc.Spec.TaskTemplate.Resources;
      const nanoCpus = res?.Limits?.NanoCPUs || res?.Reservations?.NanoCPUs;
      const memBytes = res?.Limits?.MemoryBytes || res?.Reservations?.MemoryBytes;
      const linkServices = parseList(labels["confcity.links"]);
      // The label's mere presence takes control: `confcity.links=` (empty) means
      // "this service has no outgoing links", not "please guess them".
      const explicitLinks = labels["confcity.links"] !== undefined;
      groups.set(key, {
        cityId: hostname,
        nodeId: svc.Spec.Name,
        type: inferNodeType(image, labels),
        label: labels["confcity.label"] ?? svc.Spec.Name,
        description: labels["confcity.description"],
        group: labels["confcity.group"],
        hidden: parseBool(labels["confcity.hidden"]),
        ingress: parseBool(labels["confcity.ingress"]),
        ambient: parseBool(labels["confcity.ambient"]),
        linkServices,
        explicitLinks,
        inferredLinkServices: explicitLinks
          ? []
          : inferLinksFromEnv(svc.Spec.TaskTemplate.ContainerSpec.Env, serviceNames, svc.Spec.Name),
        cpuLimit: nanoCpus ? Math.round((nanoCpus / 1e9) * 100) / 100 : undefined,
        memLimitMb: memBytes ? Math.round(memBytes / (1024 * 1024)) : undefined,
        serviceId: svc.ID,
        swarmNodeId: task.NodeID,
        containerIds: [],
        taskStates: [],
      });
    }

    const g = groups.get(key)!;
    g.taskStates.push(task.Status.State);
    const cid = task.Status.ContainerStatus?.ContainerID;
    if (cid) {
      g.containerIds.push(cid);
    }
  }

  return Array.from(groups.values());
}

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
        cpuCores: r?.NanoCPUs ? Math.round((r.NanoCPUs / 1e9) * 100) / 100 : undefined,
        memMb: r?.MemoryBytes ? Math.round(r.MemoryBytes / (1024 * 1024)) : undefined,
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
      provider.sendNodeMeta(buildMetaBatch(topology), cityMeta);
    }
  } catch (err) {
    console.error("[swarm] Failed to refresh topology:", err);
  }
}

/**
 * A target that a large share of services point to *by inference* is almost always
 * ambient infrastructure — auth, log store, metrics — whose URL sits in everyone's
 * environment. Drawing a road from every building to it buries the real topology
 * under a star, so inferred links to such hubs are dropped. Explicit
 * `confcity.links` are never filtered: declare the link to keep it.
 */
const HUB_MIN_SOURCES = 3;
const HUB_SOURCE_RATIO = 0.4;

/**
 * `AMBIENT_SERVICES` complements the `confcity.ambient` label for services whose
 * stack file is not at hand: same effect, configured on this provider instead.
 */
const ambientFromEnv = new Set(parseList(process.env.AMBIENT_SERVICES));

let lastHubsLogged = "";
let lastAmbientLogged = "";

function findInferredHubs(topo: TopologyEntry[]): Set<string> {
  const services = new Set<string>();
  const sourcesOf = new Map<string, Set<string>>();
  for (const e of topo) {
    if (e.hidden) {
      continue;
    }
    services.add(e.nodeId);
    if (e.explicitLinks) {
      continue;
    }
    for (const target of e.inferredLinkServices) {
      if (target === e.nodeId) {
        continue;
      }
      let sources = sourcesOf.get(target);
      if (!sources) {
        sources = new Set();
        sourcesOf.set(target, sources);
      }
      sources.add(e.nodeId);
    }
  }

  const hubs = new Set<string>();
  for (const [target, sources] of sourcesOf) {
    if (sources.size >= HUB_MIN_SOURCES && sources.size >= (services.size - 1) * HUB_SOURCE_RATIO) {
      hubs.add(target);
    }
  }

  const key = [...hubs].sort().join(",");
  if (key !== lastHubsLogged) {
    lastHubsLogged = key;
    if (hubs.size > 0) {
      console.log(`[swarm] Inferred-link hubs treated as ambient infrastructure: ${key}`);
    }
  }
  return hubs;
}

/** Resolve `confcity.links` service names to full addresses (a service may run on several nodes). */
function buildMetaBatch(topo: TopologyEntry[]): Record<string, NodeMeta> {
  const addressesOfService = new Map<string, string[]>();
  for (const e of topo) {
    if (e.hidden) {
      continue;
    }
    const list = addressesOfService.get(e.nodeId) ?? [];
    list.push(`${e.cityId}/${e.nodeId}`);
    addressesOfService.set(e.nodeId, list);
  }
  const resolve = (names: string[], from: string) => {
    const out: string[] = [];
    for (const name of names) {
      const targets = addressesOfService.get(name);
      if (!targets) {
        console.warn(`[swarm] ${from}: confcity.links references unknown service "${name}"`);
        continue;
      }
      // Prefer the replica on the same node when one exists, otherwise link to every node running it.
      const sameCity = targets.filter((a) => a.startsWith(`${from.split("/")[0]}/`));
      out.push(...(sameCity.length > 0 ? sameCity : targets));
    }
    return [...new Set(out)];
  };

  const hubs = findInferredHubs(topo);

  // Ambient infrastructure — auth, log store… — keeps its building but attracts
  // no road, even declared ones: everyone talks to it, drawing it teaches nothing.
  const ambient = new Set(ambientFromEnv);
  for (const e of topo) {
    if (e.ambient) {
      ambient.add(e.nodeId);
    }
  }
  const ambientKey = [...ambient].sort().join(",");
  if (ambientKey !== lastAmbientLogged) {
    lastAmbientLogged = ambientKey;
    if (ambient.size > 0) {
      console.log(`[swarm] Ambient services (links to them dropped): ${ambientKey}`);
    }
  }

  const batch: Record<string, NodeMeta> = {};
  for (const e of topo) {
    const addr = `${e.cityId}/${e.nodeId}`;
    const names = (
      e.explicitLinks ? e.linkServices : e.inferredLinkServices.filter((n) => !hubs.has(n))
    ).filter((n) => !ambient.has(n));
    const links = resolve(names, addr).filter((a) => a !== addr);
    batch[addr] = {
      type: e.type,
      label: e.label,
      description: e.description,
      group: e.group,
      hidden: e.hidden || undefined,
      ingress: e.ingress || undefined,
      links: links.length > 0 ? links : undefined,
      linksInferred: !e.explicitLinks && links.length > 0 ? true : undefined,
    };
  }
  return batch;
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
        snap.cpuLimit = Math.round(entry.cpuLimit * replicas * 100) / 100;
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

/** Entries fetched per live tick. */
const LIVE_LOG_LIMIT = Number(process.env.LOGS_LIVE_LIMIT) || 200;
/**
 * How far back a live poll re-reads. A store ingests with a lag, so a cursor that only ever
 * moves forward silently drops every line that landed late; the overlap is deduplicated by
 * content below.
 */
const LOG_OVERLAP_MS = 2_000;
/** Ceiling on a single live window, so a long disconnection does not ask for hours at once. */
const LOG_MAX_WINDOW_MS = 5 * 60_000;
/** How long a pushed line stays known, to absorb the overlap without re-sending it. */
const LOG_DEDUP_RETENTION_MS = 60_000;

let logCursor = Date.now() - 5_000;
const sentLogKeys = new Map<string, number>();

/**
 * The nodes we want logs for.
 *
 * Hidden nodes are excluded on purpose: agents and exporters are noise, and this provider's
 * own service would otherwise read — and re-emit — its own output.
 */
function buildLogTargets(addresses?: string[]): LogTarget[] {
  const wanted = addresses?.length ? new Set(addresses) : undefined;
  const targets: LogTarget[] = [];

  for (const e of topology) {
    if (e.hidden) {
      continue;
    }
    const address = `${e.cityId}/${e.nodeId}`;
    if (wanted && !wanted.has(address)) {
      continue;
    }
    targets.push({
      address,
      cityId: e.cityId,
      nodeId: e.nodeId,
      serviceId: e.serviceId,
      swarmNodeId: e.swarmNodeId,
    });
  }

  return targets;
}

async function collectLogs(): Promise<LogEntry[]> {
  const targets = buildLogTargets();
  if (targets.length === 0) {
    return [];
  }

  const until = Date.now();
  const since = Math.max(logCursor - LOG_OVERLAP_MS, until - LOG_MAX_WINDOW_MS);
  const entries = await logSource.fetch({ targets, since, until, limit: LIVE_LOG_LIMIT });
  logCursor = until;

  const fresh = entries.filter((e) => !sentLogKeys.has(logKey(e)));
  for (const e of fresh) {
    sentLogKeys.set(logKey(e), until);
  }
  for (const [key, at] of sentLogKeys) {
    if (until - at > LOG_DEDUP_RETENTION_MS) {
      sentLogKeys.delete(key);
    }
  }

  return fresh;
}

// ── Main ──

const capabilities: ProviderCapability[] = ["metrics", "liveness", "logs"];
// Only a real log store can serve a past window; the Docker API just tails.
if (logSource.supportsHistory) {
  capabilities.push("logs-query");
}

const provider = new BaseProvider({
  id: process.env.PROVIDER_ID ?? "swarm-provider",
  type: "docker-swarm",
  capabilities,
  onQueryLogs: logSource.supportsHistory
    ? async (q) => {
        const targets = buildLogTargets(q.nodes);
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

provider.start();

// Async collection loops (push directly instead of using interval-based collect,
// because Docker API calls are async and BaseProvider.intervals expects sync functions).

let running = true;

const metricsMs = Number(process.env.SWARM_METRICS_INTERVAL) || 5_000;
const livenessMs = Number(process.env.SWARM_LIVENESS_INTERVAL) || 5_000;
const logsMs = Number(process.env.SWARM_LOGS_INTERVAL) || 3_000;

async function metricsLoop() {
  while (running) {
    await Bun.sleep(metricsMs);
    if (!running || !provider.connected) {
      continue;
    }
    const data = collectMetrics();
    if (data) {
      provider.sendMetrics(data);
    }
  }
}

async function livenessLoop() {
  while (running) {
    await Bun.sleep(livenessMs);
    if (!running || !provider.connected) {
      continue;
    }
    const data = collectLiveness();
    if (data) {
      provider.sendLiveness(data);
    }
  }
}

async function logsLoop() {
  while (running) {
    await Bun.sleep(logsMs);
    if (!running || !provider.connected) {
      continue;
    }
    try {
      const data = await collectLogs();
      if (data.length > 0) {
        provider.sendLogs(data);
      }
    } catch (err) {
      console.error("[swarm] Logs error:", err);
    }
  }
}

function shutdown() {
  console.log("[swarm] Shutting down...");
  running = false;
  clearInterval(topoTimer);
  provider.stop();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

metricsLoop();
livenessLoop();
logsLoop();

console.log("[swarm] Provider started");
