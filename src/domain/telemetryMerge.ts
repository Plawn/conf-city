import { mergeLogs } from "@proxy/logKey";
import type { MetricSample } from "./telemetry";
import type { CityMetrics, LogEntry, NodeTelemetry } from "./types";

/** Samples kept per node. */
export const HISTORY_LEN = 60;
/**
 * Lines kept client-side. Roomier than a pure live tail needs, because a 24h backfill lands
 * in the same buffer and must not immediately evict everything arriving live.
 */
export const LOG_CAP = 2_000;

/** Folds an `update` delta over the previous telemetry map (a new Map, merged metrics). */
export function mergeTelemetryUpdate(
  prev: Map<string, NodeTelemetry>,
  nodes: Record<string, Partial<NodeTelemetry>>,
): Map<string, NodeTelemetry> {
  const next = new Map(prev);
  for (const [addr, partial] of Object.entries(nodes)) {
    const existing = next.get(addr);
    if (existing) {
      next.set(addr, {
        ...existing,
        ...partial,
        metrics: { ...existing.metrics, ...partial.metrics },
      });
    } else {
      const metrics = partial.metrics ?? {};
      next.set(addr, {
        liveness: "unknown",
        lastSeen: Date.now(),
        ...partial,
        metrics,
      } as NodeTelemetry);
    }
  }
  return next;
}

/**
 * Folds a metadata batch into the current map, keeping the *same* Map (and the
 * same entry objects) when nothing actually changed.
 *
 * The proxy re-broadcasts a full snapshot every 5 s, metadata included, and the
 * metadata almost never changes. A fresh Map on every snapshot would still be a
 * new identity: discovery would re-run, the whole world would be laid out again
 * and every route would be rebuilt — which empties the traffic pools, so no
 * vehicle on a trip longer than 5 s ever reached its destination.
 *
 * `replace` is the snapshot semantics (an entry absent from the batch is gone);
 * without it the batch is a delta merged over the previous map.
 */
export function reconcileMeta<T>(
  prev: Map<string, T>,
  batch: Record<string, T>,
  replace: boolean,
): Map<string, T> {
  const entries = Object.entries(batch);
  let changed = replace && prev.size !== entries.length;
  const next = replace ? new Map<string, T>() : new Map(prev);
  for (const [key, value] of entries) {
    const existing = prev.get(key);
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(value)) {
      next.set(key, existing);
    } else {
      next.set(key, value);
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** Appends one sample to `addr`'s ring buffer, capped at `HISTORY_LEN`; false when there was nothing to sample. */
export function pushSample(
  history: Map<string, MetricSample[]>,
  addr: string,
  metrics: NodeTelemetry["metrics"] | undefined,
  t: number,
): boolean {
  if (!metrics) {
    return false;
  }
  const { cpu, memoryMb, rps, latencyMs, errorRate } = metrics;
  if (cpu == null && memoryMb == null && rps == null && latencyMs == null && errorRate == null) {
    return false;
  }
  let buf = history.get(addr);
  if (!buf) {
    buf = [];
    history.set(addr, buf);
  }
  buf.push({ t, cpu, memoryMb, rps, latencyMs, errorRate });
  if (buf.length > HISTORY_LEN) {
    buf.splice(0, buf.length - HISTORY_LEN);
  }
  return true;
}

/** Live tail and backfill merged, deduplicated and capped at `LOG_CAP`. */
export function appendLogs(prev: LogEntry[], entries: LogEntry[]): LogEntry[] {
  const merged = mergeLogs(prev, entries);
  return merged.length > LOG_CAP ? merged.slice(-LOG_CAP) : merged;
}

/** Host samples of an `update` merged over the previous ones. */
export function mergeCityMetrics(
  prev: Map<string, CityMetrics>,
  batch: Record<string, CityMetrics>,
): Map<string, CityMetrics> {
  const next = new Map(prev);
  for (const [id, m] of Object.entries(batch)) {
    next.set(id, m);
  }
  return next;
}
