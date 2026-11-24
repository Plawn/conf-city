// Service usage and machine stats read from VictoriaMetrics instead of each node's daemon.
//
// Writes exactly the per-node agent's fields (docker-node.ts) — cpu, memoryMb, netRxKbps,
// netTxKbps and CityMetrics — so the disjoint-fields rule with docker-swarm.ts still holds.
// Sources: Telegraf's `docker` input (containers) and node_exporter (machines).

import type { CityMetrics, MetricSnapshot } from "../../protocol.ts";
import { round } from "../units.ts";

export interface VictoriaMetricsConfig {
  /** Prometheus-compatible base: `http://vm:8428`, or `…/select/0/prometheus` on a cluster. */
  url: string;
  timeoutMs: number;
  /** `rate()` window — a few scrape intervals. */
  window: string;
  /** Label matchers selecting the container series, e.g. `job="telegraf"`. */
  containerFilter: string;
  /** Label matchers selecting the node_exporter series, e.g. `job="node"`. */
  nodeFilter: string;
  /** Container label holding the Swarm node hostname (the cityId). */
  hostLabel: string;
  /** Container label holding the Swarm service name (the nodeId). */
  serviceLabel: string;
  /** node_exporter label holding the machine hostname (the cityId). */
  instanceLabel: string;
  /** Mountpoint measured for disk space. */
  rootMount: string;
  /** Devices left out of disk throughput: virtual devices would count their disks twice. */
  diskDeviceExclude: string;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    url: (env.VICTORIAMETRICS_URL ?? "http://victoriametrics:8428").replace(/\/+$/, ""),
    timeoutMs: Number(env.VICTORIAMETRICS_TIMEOUT_MS) || 8_000,
    window: env.VM_RATE_WINDOW ?? "30s",
    containerFilter: env.VM_CONTAINER_FILTER ?? 'job="telegraf"',
    nodeFilter: env.VM_NODE_FILTER ?? 'job="node"',
    hostLabel: env.VM_HOST_LABEL ?? "engine_host",
    serviceLabel: env.VM_SERVICE_LABEL ?? "com_docker_swarm_service_name",
    instanceLabel: env.VM_INSTANCE_LABEL ?? "instance",
    rootMount: env.VM_ROOT_MOUNT ?? "/",
    diskDeviceExclude: env.VM_DISK_DEVICE_EXCLUDE ?? "(loop|ram|zram|sr|fd|dm-|md).*",
  } satisfies VictoriaMetricsConfig;
}

/** `{a, b}` from matcher fragments, skipping empty ones. */
function sel(...parts: string[]): string {
  return `{${parts.filter(Boolean).join(",")}}`;
}

export type ServiceField = "cpu" | "memoryMb" | "netRxKbps" | "netTxKbps";
export type MachineField = Exclude<keyof CityMetrics, "at">;

/** One PromQL query per protocol field, aggregated to the address the field lands on. */
export function buildQueries(c: VictoriaMetricsConfig) {
  const by = `by (${c.hostLabel}, ${c.serviceLabel})`;
  const ct = (extra = "") => sel(c.containerFilter, `${c.serviceLabel}!=""`, extra);
  const inst = `by (${c.instanceLabel})`;
  const nd = (extra = "") => sel(c.nodeFilter, extra);
  const disk = nd(`device!~"${c.diskDeviceExclude}"`);
  const fs = nd(`mountpoint="${c.rootMount}"`);

  const service: Record<ServiceField, string> = {
    // ns of CPU per second / 1e7 = percent of one core, the `docker stats` scale.
    cpu: `sum ${by} (rate(docker_container_cpu_usage_total${ct('cpu="cpu-total"')}[${c.window}])) / 1e7`,
    // Page cache is reclaimable — subtracted like memUsedBytes() does.
    memoryMb: `sum ${by} (clamp_min(docker_container_mem_usage${ct()} - docker_container_mem_inactive_file${ct()}, 0)) / 1048576`,
    // Summed over every interface (one series per attached network).
    netRxKbps: `sum ${by} (rate(docker_container_net_rx_bytes${ct()}[${c.window}])) * 8 / 1000`,
    netTxKbps: `sum ${by} (rate(docker_container_net_tx_bytes${ct()}[${c.window}])) * 8 / 1000`,
  };

  const machine: Record<MachineField, string> = {
    // Busy = everything but idle and iowait, as host-stats.ts reads /proc/stat.
    cpuUsedCores: `sum ${inst} (rate(node_cpu_seconds_total${nd('mode!~"idle|iowait"')}[${c.window}]))`,
    memUsedMb: `max ${inst} (node_memory_MemTotal_bytes${nd()} - node_memory_MemAvailable_bytes${nd()}) / 1048576`,
    load1: `max ${inst} (node_load1${nd()})`,
    // blocks - bfree, `df` semantics like statfs in host-stats.ts.
    diskUsedMb: `max ${inst} (node_filesystem_size_bytes${fs} - node_filesystem_free_bytes${fs}) / 1048576`,
    diskTotalMb: `max ${inst} (node_filesystem_size_bytes${fs}) / 1048576`,
    diskReadMbPerSec: `sum ${inst} (rate(node_disk_read_bytes_total${disk}[${c.window}])) / 1048576`,
    diskWriteMbPerSec: `sum ${inst} (rate(node_disk_written_bytes_total${disk}[${c.window}])) / 1048576`,
  };

  return { service, machine };
}

/** One series of an instant-query answer. */
export interface Sample {
  metric: Record<string, string>;
  /** [unix seconds, value as string] */
  value: [number, string];
}

/** How each field is rounded — the same precision the agent sends. */
const SERVICE_DIGITS: Record<ServiceField, number> = {
  cpu: 1,
  memoryMb: 0,
  netRxKbps: 0,
  netTxKbps: 0,
};
const MACHINE_DIGITS: Record<MachineField, number> = {
  cpuUsedCores: 2,
  memUsedMb: 0,
  load1: 2,
  diskUsedMb: 0,
  diskTotalMb: 0,
  diskReadMbPerSec: 2,
  diskWriteMbPerSec: 2,
};

function sampleValue(s: Sample): number | null {
  const v = Number(s.value[1]);
  return Number.isFinite(v) ? v : null;
}

/** Fold the per-field answers into the two maps `sendMetrics()` takes. */
export function assemble(
  c: VictoriaMetricsConfig,
  service: Partial<Record<ServiceField, Sample[]>>,
  machine: Partial<Record<MachineField, Sample[]>>,
): { nodes: Record<string, MetricSnapshot>; cities: Record<string, CityMetrics> } {
  const nodes: Record<string, MetricSnapshot> = {};
  for (const [field, samples] of Object.entries(service) as [ServiceField, Sample[]][]) {
    for (const s of samples) {
      const host = s.metric[c.hostLabel];
      const svc = s.metric[c.serviceLabel];
      const v = sampleValue(s);
      if (!host || !svc || v == null) {
        continue;
      }
      const key = `${host}/${svc}`;
      const snap = nodes[key] ?? {};
      nodes[key] = snap;
      snap[field] = round(v, SERVICE_DIGITS[field]);
    }
  }

  const cities: Record<string, CityMetrics> = {};
  for (const [field, samples] of Object.entries(machine) as [MachineField, Sample[]][]) {
    for (const s of samples) {
      const host = s.metric[c.instanceLabel];
      const v = sampleValue(s);
      if (!host || v == null) {
        continue;
      }
      const city = cities[host] ?? { at: 0 };
      cities[host] = city;
      city[field] = round(v, MACHINE_DIGITS[field]);
      // Sample time, not poll time: VM answers with the last scrape in its lookback.
      city.at = Math.max(city.at, Math.round(s.value[0] * 1000));
    }
  }

  return { nodes, cities };
}

/** Minimal client for `/api/v1/query`. */
export class VictoriaMetricsClient {
  constructor(private c: VictoriaMetricsConfig) {}

  async query(promql: string): Promise<Sample[]> {
    const res = await fetch(`${this.c.url}/api/v1/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: promql }),
      signal: AbortSignal.timeout(this.c.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`VictoriaMetrics ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { status: string; data?: { result?: Sample[] } };
    if (body.status !== "success") {
      throw new Error(`VictoriaMetrics answered ${body.status}`);
    }
    return body.data?.result ?? [];
  }
}
