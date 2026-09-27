import type { LogEntry } from "./types";

/** Client-side log filtering and the backfill ranges of the log panel. */

export const LEVELS: LogEntry["level"][] = ["error", "warn", "info", "debug"];

/** How far back the panel asks for history when it opens. */
export const RANGES = [
  { value: "15m", label: "15m", ms: 15 * 60_000 },
  { value: "1h", label: "1h", ms: 60 * 60_000 },
  { value: "24h", label: "24h", ms: 24 * 60 * 60_000 },
] as const;
export type Range = (typeof RANGES)[number]["value"];

/** Width of a backfill range, the first one when unknown. */
export const rangeMs = (range: Range): number =>
  RANGES.find((r) => r.value === range)?.ms ?? RANGES[0].ms;

/** Entries of an enabled level whose node matches `nodeFilter` and whose message or node matches `searchText`. */
export function filterLogs(
  logs: LogEntry[],
  levelFilter: Set<LogEntry["level"]>,
  nodeFilter: string,
  searchText: string,
): LogEntry[] {
  const nf = nodeFilter.toLowerCase();
  const s = searchText.toLowerCase();
  return logs.filter((entry) => {
    if (!levelFilter.has(entry.level)) {
      return false;
    }
    if (nf && !entry.node.toLowerCase().includes(nf)) {
      return false;
    }
    if (s && !entry.message.toLowerCase().includes(s) && !entry.node.toLowerCase().includes(s)) {
      return false;
    }
    return true;
  });
}
