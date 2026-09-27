import type { CityMeta, CityMetrics, NodeTelemetry } from "../types";
import { formatMb, formatMbPerSec } from "./format";

export interface CityUsage {
  /** Usage shown for the city: the machine when measured, else the sum of its services. */
  cpuUsedCores: number;
  cpuCores?: number;
  cpuPct?: number;
  memUsedMb: number;
  memMb?: number;
  memPct?: number;
  nodeCount: number;
  /**
   * true when the figures come from the host itself (procfs). false means they are the
   * sum of the visible services, which ignores the kernel, the daemon and every
   * container outside the orchestrator — usually most of a machine's CPU.
   */
  fromHost: boolean;
  /** Sum over the city's services, always computed — the machine's share of it. */
  servicesCpuCores: number;
  servicesMemUsedMb: number;
  /** 1-minute load average, host-measured only. */
  load1?: number;
  /**
   * Disk of the machine, host-measured only — there is no service-sum fallback: a
   * filesystem belongs to the box, not to the containers scheduled on it.
   */
  diskUsedMb?: number;
  diskTotalMb?: number;
  diskPct?: number;
  diskReadMbPerSec?: number;
  diskWriteMbPerSec?: number;
}

/**
 * Usage for a city. Percentages use the city capacity from `CityMeta` (Swarm node
 * resources) and fall back to the sum of node limits.
 *
 * `host` is the machine's own measurement; when present it wins over the sum of the
 * services, which only accounts for what the orchestrator schedules.
 */
export function cityUsage(
  telemetries: Iterable<NodeTelemetry | undefined>,
  meta?: CityMeta,
  host?: CityMetrics,
): CityUsage {
  let servicesCpuCores = 0,
    servicesMemUsedMb = 0,
    cpuLimitSum = 0,
    memLimitSum = 0,
    nodeCount = 0;
  for (const t of telemetries) {
    const m = t?.metrics;
    if (!m) {
      continue;
    }
    nodeCount++;
    if (m.cpu != null) {
      servicesCpuCores += m.cpu / 100;
    }
    if (m.memoryMb != null) {
      servicesMemUsedMb += m.memoryMb;
    }
    if (m.cpuLimit) {
      cpuLimitSum += m.cpuLimit;
    }
    if (m.memLimitMb) {
      memLimitSum += m.memLimitMb;
    }
  }
  const cpuCores = meta?.cpuCores ?? (cpuLimitSum > 0 ? cpuLimitSum : undefined);
  const memMb = meta?.memMb ?? (memLimitSum > 0 ? memLimitSum : undefined);
  const fromHost = host?.cpuUsedCores != null || host?.memUsedMb != null;
  const cpuUsedCores = host?.cpuUsedCores ?? servicesCpuCores;
  const memUsedMb = host?.memUsedMb ?? servicesMemUsedMb;
  return {
    cpuUsedCores,
    cpuCores,
    cpuPct: cpuCores ? (cpuUsedCores / cpuCores) * 100 : undefined,
    memUsedMb,
    memMb,
    memPct: memMb ? (memUsedMb / memMb) * 100 : undefined,
    nodeCount,
    fromHost,
    servicesCpuCores,
    servicesMemUsedMb,
    load1: host?.load1,
    diskUsedMb: host?.diskUsedMb,
    diskTotalMb: host?.diskTotalMb,
    diskPct:
      host?.diskUsedMb != null && host.diskTotalMb
        ? (host.diskUsedMb / host.diskTotalMb) * 100
        : undefined,
    diskReadMbPerSec: host?.diskReadMbPerSec,
    diskWriteMbPerSec: host?.diskWriteMbPerSec,
  };
}

/**
 * The worst of the three machine percentages, 0..1 — what the lighthouse burns.
 *
 * Only the figures we actually have count: a machine with no disk mount is
 * judged on CPU and memory rather than dragged down to green by a missing
 * third. `undefined` means nothing at all is known, which is a dark beacon,
 * not a healthy one.
 */
export function worstUsage(u: CityUsage): number | undefined {
  let worst: number | undefined;
  for (const pct of [u.cpuPct, u.memPct, u.diskPct]) {
    if (pct == null) {
      continue;
    }
    const v = Math.max(0, pct / 100);
    if (worst == null || v > worst) {
      worst = v;
    }
  }
  return worst;
}

/**
 * Tooltip for a city usage badge. Says which of the two figures is on display — the
 * machine, or only the services we can see — because the gap between them is often
 * most of the machine.
 */
export function usageTooltip(u: CityUsage, kind: "cpu" | "mem" | "disk"): string {
  if (kind === "disk") {
    // Always the machine — a filesystem has no service-sum equivalent to compare with.
    const cap = u.diskTotalMb != null ? ` / ${formatMb(u.diskTotalMb)}` : "";
    const io =
      u.diskReadMbPerSec != null || u.diskWriteMbPerSec != null
        ? ` · ↓ ${formatMbPerSec(u.diskReadMbPerSec ?? 0)} ↑ ${formatMbPerSec(u.diskWriteMbPerSec ?? 0)}`
        : "";
    return `Machine disk: ${formatMb(u.diskUsedMb ?? 0)}${cap}${io}`;
  }
  if (kind === "cpu") {
    const cap = u.cpuCores != null ? ` / ${u.cpuCores} cores` : " cores";
    if (!u.fromHost) {
      return `Services: ${u.servicesCpuCores.toFixed(2)}${cap} — host processes and containers outside the orchestrator are not counted`;
    }
    const load = u.load1 != null ? ` · load ${u.load1.toFixed(2)}` : "";
    return `Machine: ${u.cpuUsedCores.toFixed(2)}${cap} · services ${u.servicesCpuCores.toFixed(2)}${load}`;
  }
  const cap = u.memMb != null ? ` / ${formatMb(u.memMb)}` : "";
  if (!u.fromHost) {
    return `Services: ${formatMb(u.servicesMemUsedMb)}${cap} — host memory outside the orchestrator is not counted`;
  }
  return `Machine: ${formatMb(u.memUsedMb)}${cap} · services ${formatMb(u.servicesMemUsedMb)}`;
}
