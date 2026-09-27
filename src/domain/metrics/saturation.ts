import type { MetricSnapshot, NodeTelemetry } from "../types";
import type { ViewMode } from "../viewMode";

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
