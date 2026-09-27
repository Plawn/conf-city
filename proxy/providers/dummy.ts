import type { CityMeta, NodeMeta } from "../protocol.ts";
import { BaseProvider } from "./base.ts";
import { createLogs } from "./dummy/logs.ts";
import {
  createCityMetrics,
  createLiveness,
  createNodeMetrics,
  type NodeInfo,
} from "./dummy/metrics.ts";

// ── Load topology from sample.json ──

const samplePath = new URL("../../src/data/sample.json", import.meta.url).pathname;
const sample = await Bun.file(samplePath).json();

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

const nodeMetrics = createNodeMetrics(allNodes);
const collectCityMetrics = createCityMetrics(cityMeta, nodeMetrics.last);

const provider = new BaseProvider({
  id: "dummy-provider",
  type: "dummy",
  capabilities: ["metrics", "liveness", "logs"],
  intervals: {
    metrics: { ms: 2_000, collect: nodeMetrics.collect },
    liveness: { ms: 5_000, collect: createLiveness(allNodes) },
    logs: { ms: 3_000, collect: createLogs(allNodes) },
  },
  onConnected: () => {
    provider.sendNodeMeta(buildNodeMeta(), cityMeta);
  },
});

// City metrics travel alongside node metrics; the interval collectors only know about
// nodes, so the host sample gets its own schedule.
provider.every("city metrics", 2_000, () => {
  provider.sendMetrics({}, collectCityMetrics());
});

provider.start();
