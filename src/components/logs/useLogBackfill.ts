import { useEffect, useState } from "react";
import { type Range, rangeMs } from "../../domain/logFilter";
import type { LogEntry } from "../../domain/types";
import type { LogQueryOptions } from "../../hooks/telemetryTypes";

/** Cap on a single backfill, matched to the proxy's own ceiling. */
const BACKFILL_LIMIT = 1_000;

/**
 * Backfill on open, and whenever the node filter or the range changes.
 *
 * Deliberately not keyed on `levelFilter`: levels are already applied client-side, and a
 * round-trip on every badge click would buy nothing. Resolved entries are merged into
 * `logs` by the stream hook, so there is nothing to do with them here.
 */
export function useLogBackfill({
  open,
  connected,
  serverNodes,
  range,
  queryLogs,
}: {
  open: boolean;
  connected: boolean;
  serverNodes: string;
  range: Range;
  queryLogs: (opts: LogQueryOptions) => Promise<LogEntry[]>;
}) {
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !connected) {
      return;
    }
    let cancelled = false;

    setLoadingHistory(true);
    setHistoryError(null);
    queryLogs({
      nodes: serverNodes ? [serverNodes] : undefined,
      since: Date.now() - rangeMs(range),
      limit: BACKFILL_LIMIT,
    })
      .catch((err: Error) => {
        if (!cancelled) {
          setHistoryError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingHistory(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, connected, serverNodes, range, queryLogs]);
  return { loadingHistory, historyError };
}
