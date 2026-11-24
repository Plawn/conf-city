// VictoriaMetrics provider — replaces the per-node agent (docker-node.ts) where the cluster
// already ships container and machine metrics to VictoriaMetrics (Telegraf + node_exporter).
//
// One replica, anywhere: no Docker socket, no /proc or / mounts, one query per field per tick
// for the whole cluster. Writes the agent's fields only (cpu, memoryMb, netRxKbps, netTxKbps,
// CityMetrics), so it pairs with docker-swarm.ts exactly as the agent does — never run both.

import { BaseProvider } from "./base.ts";
import {
  assemble,
  buildQueries,
  configFromEnv,
  type MachineField,
  type Sample,
  type ServiceField,
  VictoriaMetricsClient,
} from "./victoria/metrics.ts";

const config = configFromEnv();
const client = new VictoriaMetricsClient(config);
const queries = buildQueries(config);

/** Fields whose last query failed — logged on change only, not every tick. */
const failing = new Set<string>();

async function run<K extends string>(q: Record<K, string>): Promise<Partial<Record<K, Sample[]>>> {
  const keys = Object.keys(q) as K[];
  const results = await Promise.allSettled(keys.map((k) => client.query(q[k])));
  const out: Partial<Record<K, Sample[]>> = {};
  results.forEach((r, i) => {
    const k = keys[i]!;
    if (r.status === "fulfilled") {
      out[k] = r.value;
      if (failing.delete(k)) {
        console.log(`[victoria] ${k} recovered`);
      }
    } else if (!failing.has(k)) {
      failing.add(k);
      console.warn(`[victoria] ${k} query failed: ${r.reason}`);
    }
  });
  return out;
}

const provider = new BaseProvider({
  id: process.env.PROVIDER_ID ?? "victoria-metrics",
  type: "victoriametrics",
  capabilities: ["metrics"],
});

// Polling faster than the scrape interval only re-sends the same samples.
const metricsMs = Number(process.env.VM_METRICS_INTERVAL) || 10_000;
provider.every("metrics", metricsMs, async () => {
  const [service, machine] = await Promise.all([
    run<ServiceField>(queries.service),
    run<MachineField>(queries.machine),
  ]);
  const { nodes, cities } = assemble(config, service, machine);
  if (Object.keys(nodes).length > 0 || Object.keys(cities).length > 0) {
    provider.sendMetrics(nodes, cities);
  }
});

provider.stopOnSignals("victoria");
provider.start();

console.log(`[victoria] Provider started, reading ${config.url} every ${metricsMs} ms`);
