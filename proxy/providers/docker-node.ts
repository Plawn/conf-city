// Per-node stats agent.
//
// `/containers/{id}/stats` only answers for containers of the local daemon, so the
// manager-side Swarm provider cannot measure usage for tasks scheduled elsewhere.
// This agent runs `mode: global` (one instance per Swarm node) and reports usage for
// the containers it can actually see, addressed exactly like the Swarm provider does:
// `<node hostname>/<service name>`.
//
// Field split with docker-swarm.ts — the proxy merges both into the same address
// (see TelemetryStore.applyMetrics), so the two must not write the same keys:
//   this agent  → cpu, memoryMb, netRxKbps, netTxKbps   (usage, local)
//   swarm provider → cpuLimit, memLimitMb               (limits, from the service spec)
//
// On top of the per-service usage, the agent reports the *machine* itself (CityMetrics)
// from the host procfs. The two are not interchangeable: the container sum ignores the
// kernel, dockerd and every container outside Swarm, which on a typical node is most of
// the CPU actually burned.

import type { CityMetrics, MetricSnapshot } from "../protocol.ts";
import { BaseProvider } from "./base.ts";
import {
  type ContainerSample,
  type ContainerStats,
  cpuPercentBetween,
  DockerClient,
  memUsedBytes,
  netKbpsBetween,
  sampleOf,
} from "./docker-api.ts";
import { HostStatsReader } from "./host-stats.ts";

/** Label Swarm puts on every task container, holding the service name. */
const SERVICE_LABEL = "com.docker.swarm.service.name";

interface ContainerSummary {
  Id: string;
  Labels?: Record<string, string>;
}

const docker = new DockerClient();
/** Previous poll, per container id — CPU and network are rates, not gauges. */
const lastSample = new Map<string, ContainerSample>();
/** Machine-level usage, straight from the host procfs (null when not mounted). */
const hostStats = new HostStatsReader();

/** Swarm node hostname — the `cityId` half of every address. */
let hostname = "";
/** Host core count, fallback when a container's stats omit `online_cpus`. */
let hostCpus = 1;

async function resolveHost(): Promise<{ name: string; cpus: number }> {
  const info = await docker.get<{ Name: string; NCPU?: number }>("/info");
  if (!info.Name) {
    throw new Error("Docker /info returned no Name");
  }
  return { name: info.Name, cpus: info.NCPU || 1 };
}

/** Local running containers grouped by the Swarm service they belong to. */
async function localServiceContainers(): Promise<Map<string, string[]>> {
  const containers = await docker.get<ContainerSummary[]>("/containers/json");
  const byService = new Map<string, string[]>();
  for (const c of containers) {
    const service = c.Labels?.[SERVICE_LABEL];
    if (!service) {
      continue; // not a Swarm task (plain `docker run`) — no matching address
    }
    const list = byService.get(service) ?? [];
    list.push(c.Id);
    byService.set(service, list);
  }
  return byService;
}

async function collectMetrics(): Promise<Record<string, MetricSnapshot> | null> {
  const byService = await localServiceContainers();
  if (byService.size === 0) {
    return null;
  }

  const out: Record<string, MetricSnapshot> = {};
  const now = Date.now();
  const alive = new Set<string>();

  await Promise.allSettled(
    [...byService].map(async ([service, containerIds]) => {
      const results = await Promise.allSettled(
        containerIds.map((cid) =>
          docker.get<ContainerStats>(`/containers/${cid}/stats?stream=false&one-shot=true`),
        ),
      );

      let totalCpu = 0;
      let totalMemMb = 0;
      let rxKbps = 0;
      let txKbps = 0;
      let hasCpu = false;
      let hasNet = false;
      let count = 0;

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status !== "fulfilled") {
          continue;
        }
        const stats = r.value;
        const cid = containerIds[i]!;
        alive.add(cid);

        const cur = sampleOf(stats, now);
        const prev = lastSample.get(cid);
        lastSample.set(cid, cur);

        if (prev) {
          const cpu = cpuPercentBetween(prev, cur, stats.cpu_stats?.online_cpus || hostCpus);
          if (cpu != null) {
            totalCpu += cpu;
            hasCpu = true;
          }
          const net = netKbpsBetween(prev, cur);
          if (net) {
            rxKbps += net.rxKbps;
            txKbps += net.txKbps;
            hasNet = true;
          }
        }

        totalMemMb += memUsedBytes(stats.memory_stats) / (1024 * 1024);
        count++;
      }

      if (count === 0) {
        return;
      }

      // Summed over the replicas running on this node — the swarm provider scales the
      // per-replica limits by the same replica count, so saturation stays comparable.
      // cpu/net stay absent until a second poll gives us a delta.
      const snap: MetricSnapshot = { memoryMb: Math.round(totalMemMb) };
      if (hasCpu) {
        snap.cpu = Math.round(totalCpu * 10) / 10;
      }
      if (hasNet) {
        snap.netRxKbps = Math.round(rxKbps);
        snap.netTxKbps = Math.round(txKbps);
      }
      out[`${hostname}/${service}`] = snap;
    }),
  );

  // Drop baselines of containers that went away, so a recycled id can't produce a
  // bogus delta.
  for (const cid of lastSample.keys()) {
    if (!alive.has(cid)) {
      lastSample.delete(cid);
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ── Main ──

const host = await resolveHost();
hostname = host.name;
hostCpus = host.cpus;

const provider = new BaseProvider({
  id: process.env.PROVIDER_ID ?? `node-agent-${hostname}`,
  type: "docker-node",
  capabilities: ["metrics"],
});

provider.start();

// Async collection loop (Docker API calls are async; BaseProvider.intervals expects sync).
let running = true;
const metricsMs = Number(process.env.NODE_METRICS_INTERVAL) || 5_000;

async function metricsLoop() {
  while (running) {
    await Bun.sleep(metricsMs);
    if (!running || !provider.connected) {
      continue;
    }
    try {
      const now = Date.now();
      const [data, machine] = await Promise.all([
        collectMetrics(),
        hostStats.read(now).catch(() => null),
      ]);
      const cities: Record<string, CityMetrics> | undefined = machine
        ? { [hostname]: machine }
        : undefined;
      if (data || cities) {
        provider.sendMetrics(data ?? {}, cities);
      }
    } catch (err) {
      console.error("[node] Metrics error:", err);
    }
  }
}

function shutdown() {
  console.log("[node] Shutting down...");
  running = false;
  provider.stop();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

metricsLoop();

console.log(`[node] Provider started for "${hostname}" (${hostCpus} cores)`);
