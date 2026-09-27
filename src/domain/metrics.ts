import { clamp01 } from "../lib/math";
import type { ViewMode } from "../store/uiStore";
import type { CityMeta, CityMetrics, MetricSnapshot, NodeTelemetry } from "./types";

/** CPU saturation 0..1+ : usage vs allocated cores (Docker-style cpu% = 100 per core). */
export function cpuSaturation(m: MetricSnapshot | undefined): number | undefined {
  if (m?.cpu == null) {
    return undefined;
  }
  const cores = m.cpuLimit && m.cpuLimit > 0 ? m.cpuLimit : 1;
  return m.cpu / (cores * 100);
}

/** Memory saturation 0..1+ : usage vs limit; undefined when no limit is known. */
export function memSaturation(m: MetricSnapshot | undefined): number | undefined {
  if (m?.memoryMb == null || !m.memLimitMb) {
    return undefined;
  }
  return m.memoryMb / m.memLimitMb;
}

export function netKbps(m: MetricSnapshot | undefined): number | undefined {
  if (m?.netRxKbps == null && m?.netTxKbps == null) {
    return undefined;
  }
  return (m?.netRxKbps ?? 0) + (m?.netTxKbps ?? 0);
}

/** Per-city maxima used to normalise the heatmap and building heights. */
export interface CityMax {
  memoryMb: number;
  cpu: number;
  netKbps: number;
}

export function cityMax(telemetries: Iterable<NodeTelemetry | undefined>): CityMax {
  const out: CityMax = { memoryMb: 0, cpu: 0, netKbps: 0 };
  for (const t of telemetries) {
    const m = t?.metrics;
    if (!m) {
      continue;
    }
    if (m.memoryMb != null) {
      out.memoryMb = Math.max(out.memoryMb, m.memoryMb);
    }
    if (m.cpu != null) {
      out.cpu = Math.max(out.cpu, m.cpu);
    }
    const n = netKbps(m);
    if (n != null) {
      out.netKbps = Math.max(out.netKbps, n);
    }
  }
  return out;
}

/** log-normalised memory 0..1 relative to the biggest consumer of the city. */
export function memoryHeight(m: MetricSnapshot | undefined, max: CityMax): number | undefined {
  if (m?.memoryMb == null || max.memoryMb <= 0) {
    return undefined;
  }
  return Math.log1p(m.memoryMb) / Math.log1p(max.memoryMb);
}

/**
 * Heat value 0..1 for the current view mode.
 * Saturation vs limit when a limit is known, otherwise relative to the city's max.
 */
export function heatValue(
  mode: ViewMode,
  m: MetricSnapshot | undefined,
  max: CityMax,
): number | undefined {
  if (!m) {
    return undefined;
  }
  switch (mode) {
    case "cpu": {
      if (m.cpu == null) {
        return undefined;
      }
      return m.cpuLimit ? cpuSaturation(m) : max.cpu > 0 ? m.cpu / max.cpu : 0;
    }
    case "memory": {
      if (m.memoryMb == null) {
        return undefined;
      }
      return m.memLimitMb ? memSaturation(m) : max.memoryMb > 0 ? m.memoryMb / max.memoryMb : 0;
    }
    case "network": {
      const n = netKbps(m);
      if (n == null) {
        return undefined;
      }
      return max.netKbps > 0 ? n / max.netKbps : 0;
    }
    default:
      return undefined;
  }
}

/** Raw value + unit for ranking / bars, per view mode (health → memory). */
export function rankValue(mode: ViewMode, m: MetricSnapshot | undefined): number | undefined {
  switch (mode) {
    case "cpu":
      return m?.cpu;
    case "network":
      return netKbps(m);
    default:
      return m?.memoryMb;
  }
}

export const RANK_LABEL: Record<ViewMode, string> = {
  health: "Memory",
  cpu: "CPU",
  memory: "Memory",
  network: "Network",
};

export function formatRank(mode: ViewMode, v: number): string {
  switch (mode) {
    case "cpu":
      return `${v.toFixed(0)}%`;
    case "network":
      return formatKbps(v);
    default:
      return formatMb(v);
  }
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Disk throughput. Megabytes per second, the unit disks are read in. */
export function formatMbPerSec(mbs: number): string {
  if (mbs >= 1024) {
    return `${(mbs / 1024).toFixed(1)} GB/s`;
  }
  if (mbs >= 10) {
    return `${Math.round(mbs)} MB/s`;
  }
  return `${mbs.toFixed(1)} MB/s`;
}

export function formatKbps(kbps: number): string {
  if (kbps >= 1_000_000) {
    return `${(kbps / 1_000_000).toFixed(1)} Gb/s`;
  }
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(1)} Mb/s`;
  }
  return `${Math.round(kbps)} kb/s`;
}

/** Green → orange → red ramp; t clamped to 0..1. Returns a CSS hex colour. */
export function heatColor(t: number): string {
  const x = clamp01(t);
  // stops: 0 → #3ddc84 (green), 0.5 → #ffb020 (orange), 1 → #ff3b3b (red)
  const stops: [number, [number, number, number]][] = [
    [0, [0x3d, 0xdc, 0x84]],
    [0.5, [0xff, 0xb0, 0x20]],
    [1, [0xff, 0x3b, 0x3b]],
  ];
  let a = stops[0]!,
    b = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i]![0] && x <= stops[i + 1]![0]) {
      a = stops[i]!;
      b = stops[i + 1]!;
      break;
    }
  }
  const k = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i]! - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Tone for a saturation value (used by badges / bars). */
export function saturationTone(sat: number | undefined): "ok" | "warn" | "danger" | "muted" {
  if (sat == null) {
    return "muted";
  }
  if (sat >= 0.9) {
    return "danger";
  }
  if (sat >= 0.7) {
    return "warn";
  }
  return "ok";
}

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

/**
 * The three machine figures, turned into things a district can be built out of.
 *
 * Each one answers `undefined` when the figure is missing rather than 0: an
 * unmeasured machine gets an installation under construction, never a chimney
 * that reads as an idle CPU. `cityUsage()` is the only source — nothing here
 * asks the provider for anything new.
 */

/**
 * How hard the power station smokes, 0..1 — `undefined` when the CPU is not
 * measured. Mildly eased so the low end is still visible: a machine at 20 %
 * must not look like one at rest, which a linear ramp on a puff count does.
 */
export function smokeRate(cpuPct: number | undefined): number | undefined {
  if (cpuPct == null) {
    return undefined;
  }
  return clamp01(cpuPct / 100) ** 0.7;
}

/** How full the water tower stands, 0..1 — `undefined` when memory is unknown. */
export function tankLevel(memPct: number | undefined): number | undefined {
  return memPct == null ? undefined : clamp01(memPct / 100);
}

/** What a container quay is stacked with. */
export interface QuayLoad {
  /** Boxes on the quay, `0..capacity`. */
  count: number;
  /** A full disk: the quay is stacked past its rows and the last pile leans. */
  overflow: boolean;
}

/**
 * Boxes for a disk figure — `undefined` when nothing is mounted (no service-sum
 * fallback exists for a filesystem). An empty quay is a fresh disk, a full one
 * is a full disk, and `overflow` past 95 % is what makes "nearly full" and
 * "full" different at a glance from across the room.
 */
export function containerCount(
  diskPct: number | undefined,
  capacity: number,
): QuayLoad | undefined {
  if (diskPct == null) {
    return undefined;
  }
  const pct = clamp01(diskPct / 100);
  return { count: Math.round(pct * capacity), overflow: pct >= 0.95 };
}
