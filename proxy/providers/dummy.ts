import type {
  CityMeta,
  CityMetrics,
  LivenessStatus,
  LogEntry,
  MetricSnapshot,
  NodeMeta,
} from "../protocol.ts";
import { BaseProvider } from "./base.ts";
import { round } from "./units.ts";

// ── Load topology from sample.json ──

const samplePath = new URL("../../src/data/sample.json", import.meta.url).pathname;
const sample = await Bun.file(samplePath).json();

interface NodeInfo {
  address: string; // "cityId/nodeId"
  type: string;
  label: string;
  group?: string;
  description?: string;
  links?: string[];
  hidden?: boolean;
  cpuLimit: number; // cores
  memLimitMb: number;
}

function limitsFor(type: string): { cpuLimit: number; memLimitMb: number } {
  switch (type) {
    case "db":
      return { cpuLimit: 4, memLimitMb: 4096 };
    case "cache":
      return { cpuLimit: 1, memLimitMb: 512 };
    case "queue":
      return { cpuLimit: 1, memLimitMb: 1024 };
    default:
      return { cpuLimit: 2, memLimitMb: 1024 };
  }
}

const allNodes: NodeInfo[] = [];
for (const city of sample.cities) {
  for (const node of city.nodes) {
    allNodes.push({
      address: `${city.id}/${node.id}`,
      type: node.type,
      label: node.label,
      group: node.group,
      description: node.description,
      ...limitsFor(node.type),
    });
  }
}

// Extra nodes absent from sample.json → exercise auto-discovery, label-driven links, groups and hidden nodes.
allNodes.push(
  {
    address: "paris-1/exporter",
    type: "app",
    label: "Metrics exporter",
    description: "Scrapes PostgreSQL (discovered, links from labels)",
    group: "ops",
    links: ["paris-1/db"],
    cpuLimit: 0.5,
    memLimitMb: 256,
  },
  {
    address: "paris-1/agent",
    type: "app",
    label: "Node agent",
    hidden: true,
    cpuLimit: 0.25,
    memLimitMb: 128,
  },
);

const cityMeta: Record<string, CityMeta> = {
  "paris-1": { label: "Server Paris 1", cpuCores: 16, memMb: 32768 },
  "london-1": { label: "Server London 1", cpuCores: 8, memMb: 16384, biome: "dunes" },
};

console.log(`Loaded ${allNodes.length} nodes: ${allNodes.map((n) => n.address).join(", ")}`);

// ── Random walk helpers ──

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function walk(current: number, step: number, lo: number, hi: number) {
  return clamp(current + (Math.random() - 0.5) * 2 * step, lo, hi);
}

// ── Per-node metric state (random walk) ──

const metricState = new Map<
  string,
  {
    cpu: number;
    memoryMb: number;
    rps: number;
    latencyMs: number;
    errorRate: number;
    netRx: number;
    netTx: number;
  }
>();

function initMetrics(type: string) {
  switch (type) {
    case "app":
      return {
        cpu: 30,
        memoryMb: 512,
        rps: 200,
        latencyMs: 15,
        errorRate: 0.005,
        netRx: 800,
        netTx: 2500,
      };
    case "db":
      return {
        cpu: 40,
        memoryMb: 2048,
        rps: 500,
        latencyMs: 3,
        errorRate: 0.001,
        netRx: 1200,
        netTx: 4000,
      };
    case "cache":
      return {
        cpu: 10,
        memoryMb: 256,
        rps: 1000,
        latencyMs: 0.5,
        errorRate: 0.0005,
        netRx: 3000,
        netTx: 6000,
      };
    case "queue":
      return {
        cpu: 15,
        memoryMb: 384,
        rps: 100,
        latencyMs: 5,
        errorRate: 0.002,
        netRx: 400,
        netTx: 400,
      };
    default:
      return {
        cpu: 20,
        memoryMb: 256,
        rps: 50,
        latencyMs: 10,
        errorRate: 0.01,
        netRx: 100,
        netTx: 100,
      };
  }
}

for (const node of allNodes) {
  metricState.set(node.address, initMetrics(node.type));
}

function collectMetrics(): Record<string, MetricSnapshot> {
  const out: Record<string, MetricSnapshot> = {};
  for (const node of allNodes) {
    const s = metricState.get(node.address)!;
    s.cpu = walk(s.cpu, 5, 2, 95);
    s.memoryMb = walk(s.memoryMb, 50, 64, node.memLimitMb * 0.95);
    s.rps = walk(s.rps, 20, 0, 5000);
    s.latencyMs = walk(s.latencyMs, 3, 0.1, 500);
    s.errorRate = walk(s.errorRate, 0.005, 0, 0.15);
    s.netRx = walk(s.netRx, 300, 0, 20000);
    s.netTx = walk(s.netTx, 500, 0, 40000);
    // cpu is expressed like Docker: % of one core, can exceed 100 on multi-core limits
    const cpuPct = (s.cpu / 100) * node.cpuLimit * 100;
    out[node.address] = {
      cpu: round(cpuPct, 1),
      memoryMb: Math.round(Math.min(s.memoryMb, node.memLimitMb)),
      rps: Math.round(s.rps),
      latencyMs: round(s.latencyMs, 1),
      errorRate: round(s.errorRate, 4),
      cpuLimit: node.cpuLimit,
      memLimitMb: node.memLimitMb,
      netRxKbps: Math.round(s.netRx),
      netTxKbps: Math.round(s.netTx),
    };
  }
  lastNodeMetrics = out;
  return out;
}

// ── Host-level metrics ──
// A machine is more than the services it runs: kernel, daemons, and containers outside
// the orchestrator. The dummy reproduces that gap so the city badge exercises the same
// path as a real node agent reading /proc.

let lastNodeMetrics: Record<string, MetricSnapshot> = {};
const hostOverhead = new Map(
  Object.keys(cityMeta).map((id) => [id, { cpuCores: 0.6, memMb: 1800 }]),
);

/** Disk is a property of the box, so the dummy gives each city its own drive. */
const hostDisk = new Map<string, { totalMb: number; usedMb: number; read: number; write: number }>([
  ["paris-1", { totalMb: 512_000, usedMb: 190_000, read: 4, write: 12 }],
  ["london-1", { totalMb: 256_000, usedMb: 205_000, read: 2, write: 6 }],
]);

function collectCityMetrics(): Record<string, CityMetrics> {
  const at = Date.now();
  const out: Record<string, CityMetrics> = {};
  for (const [cityId, meta] of Object.entries(cityMeta)) {
    let cpuCores = 0;
    let memMb = 0;
    for (const [address, m] of Object.entries(lastNodeMetrics)) {
      if (!address.startsWith(`${cityId}/`)) {
        continue;
      }
      cpuCores += (m.cpu ?? 0) / 100;
      memMb += m.memoryMb ?? 0;
    }
    const overhead = hostOverhead.get(cityId)!;
    overhead.cpuCores = walk(overhead.cpuCores, 0.15, 0.1, 2.5);
    overhead.memMb = walk(overhead.memMb, 150, 600, 5000);
    const usedCores = Math.min(meta.cpuCores ?? Infinity, cpuCores + overhead.cpuCores);
    const disk = hostDisk.get(cityId);
    if (disk) {
      // Space creeps, throughput jumps around — the two behave nothing alike.
      disk.usedMb = walk(disk.usedMb, 60, disk.totalMb * 0.05, disk.totalMb * 0.97);
      disk.read = walk(disk.read, 8, 0, 300);
      disk.write = walk(disk.write, 10, 0, 400);
    }
    out[cityId] = {
      cpuUsedCores: round(usedCores, 2),
      memUsedMb: Math.round(Math.min(meta.memMb ?? Infinity, memMb + overhead.memMb)),
      load1: round(usedCores * 1.2, 2),
      ...(disk && {
        diskUsedMb: Math.round(disk.usedMb),
        diskTotalMb: disk.totalMb,
        diskReadMbPerSec: round(disk.read, 2),
        diskWriteMbPerSec: round(disk.write, 2),
      }),
      at,
    };
  }
  return out;
}

// ── Liveness ──

const livenessState = new Map<string, LivenessStatus>();
for (const node of allNodes) {
  livenessState.set(node.address, "healthy");
}

/** Markov transition: given current liveness, return next state. */
function transitionLiveness(current: LivenessStatus): LivenessStatus {
  const r = Math.random();
  const transitions: Record<LivenessStatus, [number, LivenessStatus][]> = {
    healthy: [
      [0.01, "down"],
      [0.05, "degraded"],
    ],
    degraded: [
      [0.1, "down"],
      [0.4, "healthy"],
    ],
    down: [
      [0.3, "degraded"],
      [0.5, "healthy"],
    ],
    unknown: [[0.5, "healthy"]],
  };
  for (const [threshold, next] of transitions[current]) {
    if (r < threshold) {
      return next;
    }
  }
  return current;
}

function collectLiveness(): Record<string, LivenessStatus> {
  const out: Record<string, LivenessStatus> = {};
  for (const node of allNodes) {
    const current = livenessState.get(node.address)!;
    const next = transitionLiveness(current);
    livenessState.set(node.address, next);
    out[node.address] = next;
  }
  return out;
}

// ── Logs ──

const logTemplates: Record<string, string[]> = {
  app: [
    "Request processed in {latency}ms",
    "Connection pool: {n} active",
    "Cache hit ratio: {pct}%",
    "Deployed version v1.{v}.{p}",
    "Health check passed",
    "Rate limit reached for client {ip}",
  ],
  db: [
    "Query executed in {latency}ms",
    "Vacuum completed on table users",
    "Replication lag: {n}ms",
    "Connection count: {n}",
    "Checkpoint completed",
    "Slow query detected: SELECT * FROM orders",
  ],
  cache: [
    "Evicted {n} keys (LRU)",
    "Memory usage: {pct}%",
    "Connected clients: {n}",
    "Keyspace: {n} keys",
    "Snapshot saved to disk",
  ],
  queue: [
    "Queue depth: {n} messages",
    "Consumer connected: worker-{v}",
    "Message delivered in {latency}ms",
    "Dead-letter queue: {n} messages",
    "Channel created: events.{v}",
  ],
};

function fillTemplate(tpl: string): string {
  return tpl
    .replace("{latency}", String(Math.floor(Math.random() * 200)))
    .replace("{n}", String(Math.floor(Math.random() * 100)))
    .replace("{pct}", String(Math.floor(Math.random() * 100)))
    .replace("{v}", String(Math.floor(Math.random() * 20)))
    .replace("{p}", String(Math.floor(Math.random() * 100)))
    .replace("{ip}", `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`);
}

function getLogLevel(r: number): LogEntry["level"] {
  if (r < 0.05) {
    return "error";
  }
  if (r < 0.15) {
    return "warn";
  }
  if (r < 0.3) {
    return "debug";
  }
  return "info";
}

function collectLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  const count = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const node = allNodes[Math.floor(Math.random() * allNodes.length)]!;
    const templates = logTemplates[node.type] ?? logTemplates.app!;
    const tpl = templates[Math.floor(Math.random() * templates.length)]!;
    const level = getLogLevel(Math.random());
    entries.push({
      timestamp: Date.now(),
      node: node.address,
      level,
      message: fillTemplate(tpl),
    });
  }
  return entries;
}

// ── Node metadata ──

function buildNodeMeta(): Record<string, NodeMeta> {
  const out: Record<string, NodeMeta> = {};
  for (const node of allNodes) {
    out[node.address] = {
      type: node.type,
      label: node.label,
      group: node.group,
      description: node.description,
      links: node.links,
      hidden: node.hidden,
    };
  }
  return out;
}

// ── Start ──

const provider = new BaseProvider({
  id: "dummy-provider",
  type: "dummy",
  capabilities: ["metrics", "liveness", "logs"],
  intervals: {
    metrics: { ms: 2_000, collect: collectMetrics },
    liveness: { ms: 5_000, collect: collectLiveness },
    logs: { ms: 3_000, collect: collectLogs },
  },
  onConnected: () => {
    provider.sendNodeMeta(buildNodeMeta(), cityMeta);
  },
});

provider.start();

// City metrics travel alongside node metrics; BaseProvider's interval collectors only
// know about nodes, so the host sample gets its own loop.
setInterval(() => {
  if (provider.connected) {
    provider.sendMetrics({}, collectCityMetrics());
  }
}, 2_000);
