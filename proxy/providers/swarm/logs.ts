// Live log polling for the Swarm provider: one cursor, re-read overlap, content dedup.

import { logKey } from "../../logKey.ts";
import type { LogEntry } from "../../protocol.ts";
import type { LogSource, LogTarget } from "../logsources/types.ts";
import type { TopologyEntry } from "./types.ts";

/** Entries fetched per live tick. */
const LIVE_LOG_LIMIT = Number(process.env.LOGS_LIVE_LIMIT) || 200;
/**
 * How far back a live poll re-reads. A store ingests with a lag, so a cursor that only ever
 * moves forward silently drops every line that landed late; the overlap is deduplicated by
 * content below.
 */
const LOG_OVERLAP_MS = 2_000;
/** Ceiling on a single live window, so a long disconnection does not ask for hours at once. */
const LOG_MAX_WINDOW_MS = 5 * 60_000;
/** How long a pushed line stays known, to absorb the overlap without re-sending it. */
const LOG_DEDUP_RETENTION_MS = 60_000;

/**
 * The nodes we want logs for.
 *
 * Hidden nodes are excluded on purpose: agents and exporters are noise, and this provider's
 * own service would otherwise read — and re-emit — its own output.
 */
export function buildLogTargets(topology: TopologyEntry[], addresses?: string[]): LogTarget[] {
  const wanted = addresses?.length ? new Set(addresses) : undefined;
  const targets: LogTarget[] = [];

  for (const e of topology) {
    if (e.hidden) {
      continue;
    }
    const address = `${e.cityId}/${e.nodeId}`;
    if (wanted && !wanted.has(address)) {
      continue;
    }
    targets.push({
      address,
      cityId: e.cityId,
      nodeId: e.nodeId,
      serviceId: e.serviceId,
      swarmNodeId: e.swarmNodeId,
    });
  }

  return targets;
}

/** A live collector: each call returns the lines not pushed yet since the previous one. */
export function createLogCollector(
  logSource: LogSource,
  getTopology: () => TopologyEntry[],
): () => Promise<LogEntry[]> {
  let logCursor = Date.now() - 5_000;
  const sentLogKeys = new Map<string, number>();

  return async () => {
    const targets = buildLogTargets(getTopology());
    if (targets.length === 0) {
      return [];
    }

    const until = Date.now();
    const since = Math.max(logCursor - LOG_OVERLAP_MS, until - LOG_MAX_WINDOW_MS);
    const entries = await logSource.fetch({ targets, since, until, limit: LIVE_LOG_LIMIT });
    logCursor = until;

    const fresh = entries.filter((e) => !sentLogKeys.has(logKey(e)));
    for (const e of fresh) {
      sentLogKeys.set(logKey(e), until);
    }
    for (const [key, at] of sentLogKeys) {
      if (until - at > LOG_DEDUP_RETENTION_MS) {
        sentLogKeys.delete(key);
      }
    }

    return fresh;
  };
}
