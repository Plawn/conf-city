import type { LogEntry } from "./protocol.ts";

/**
 * Identity of a log line, for deduplication.
 *
 * Neither Docker nor VictoriaLogs hands out a per-entry id, and the same line can legitimately
 * reach us twice: the live poll overlaps its cursor to survive ingestion lag, and a backfill
 * necessarily re-fetches a window the tail already delivered. Content is all we have.
 */
export function logKey(e: LogEntry): string {
  return `${e.timestamp}|${e.node}|${e.message}`;
}

/** Merge log batches, dropping duplicates and sorting oldest-first. */
export function mergeLogs(...batches: LogEntry[][]): LogEntry[] {
  const byKey = new Map<string, LogEntry>();
  for (const batch of batches) {
    for (const e of batch) {
      byKey.set(logKey(e), e);
    }
  }
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
}
