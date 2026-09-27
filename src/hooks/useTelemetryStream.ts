import { mergeLogs } from "@proxy/logKey";
import type { ProviderCapability } from "@proxy/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetricSample } from "../domain/telemetry";
import type { CityMeta, CityMetrics, LogEntry, NodeMeta, NodeTelemetry } from "../domain/types";

const DEFAULT_PROXY_URL =
  typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/frontend`
    : "ws://localhost:4001/ws/frontend";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const HISTORY_LEN = 60;
/**
 * Lines kept client-side. Roomier than a pure live tail needs, because a 24h backfill lands
 * in the same buffer and must not immediately evict everything arriving live.
 */
const LOG_CAP = 2_000;
/** Longer than the proxy's own fan-out timeout, so its answer wins over our giving up. */
const QUERY_TIMEOUT_MS = 15_000;

export interface ProviderInfo {
  id: string;
  providerType: string;
  connectedAt: number;
  capabilities?: ProviderCapability[];
}

export interface LogQueryOptions {
  nodes?: string[];
  levels?: LogEntry["level"][];
  /** epoch ms, inclusive. */
  since: number;
  /** epoch ms, exclusive. Defaults to now, server-side. */
  until?: number;
  limit?: number;
}

export interface TelemetryState {
  telemetry: Map<string, NodeTelemetry>;
  nodeMeta: Map<string, NodeMeta>;
  cityMeta: Map<string, CityMeta>;
  /** Machine-level usage per city, measured on the host (absent when no agent reports it). */
  cityMetrics: Map<string, CityMetrics>;
  telemetryKeysVersion: number;
  connected: boolean;
  error: string | null;
  providers: ProviderInfo[];
  logs: LogEntry[];
  /** Per-node ring buffer of recent metric samples (mutated in place; use historyVersion to re-read). */
  history: Map<string, MetricSample[]>;
  historyVersion: number;
  /** Timestamp of the last snapshot/update message received from the proxy. */
  lastUpdateAt: number | null;
  requestSnapshot: () => void;
  subscribeLogs: (nodes?: string[], levels?: LogEntry["level"][]) => void;
  unsubscribeLogs: () => void;
  /**
   * true when some provider can serve a past window. Without one the proxy still answers,
   * from its own small ring buffer — enough to fill the panel, not enough to call history.
   */
  canQueryLogs: boolean;
  /** Ask for logs from a past range. Resolves with the entries, already merged into `logs`. */
  queryLogs: (opts: LogQueryOptions) => Promise<LogEntry[]>;
}

function mergeTelemetryUpdate(
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
function reconcileMeta<T>(
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

function pushSample(
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

export function useTelemetryStream(): TelemetryState {
  const [telemetry, setTelemetry] = useState<Map<string, NodeTelemetry>>(() => new Map());
  const [connected, setConnected] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [nodeMeta, setNodeMeta] = useState<Map<string, NodeMeta>>(() => new Map());
  const [cityMeta, setCityMeta] = useState<Map<string, CityMeta>>(() => new Map());
  const [cityMetrics, setCityMetrics] = useState<Map<string, CityMetrics>>(() => new Map());
  const [telemetryKeysVersion, setTelemetryKeysVersion] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const historyRef = useRef(new Map<string, MetricSample[]>());
  const knownKeysRef = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingQueriesRef = useRef(
    new Map<
      string,
      {
        resolve: (entries: LogEntry[]) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );

  /**
   * Fold a batch into `logs`. Live tail and backfill overlap by design — the provider
   * re-reads a little of each window, and a backfill necessarily covers what the tail
   * already delivered — so entries are deduplicated by content and re-sorted.
   */
  const ingestLogs = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) {
      return;
    }
    setLogs((prev) => {
      const merged = mergeLogs(prev, entries);
      return merged.length > LOG_CAP ? merged.slice(-LOG_CAP) : merged;
    });
  }, []);

  /** Fail every in-flight query: nothing will ever answer them on a closed socket. */
  const failPendingQueries = useCallback((reason: string) => {
    for (const pending of pendingQueriesRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingQueriesRef.current.clear();
  }, []);

  const proxyUrl = import.meta.env.VITE_PROXY_URL || DEFAULT_PROXY_URL;

  const connectWs = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    const ws = new WebSocket(proxyUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setConnected(true);
      setWsError(null);
      retriesRef.current = 0;
    };

    ws.onmessage = (ev) => {
      if (!mountedRef.current) {
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case "snapshot": {
            const next = new Map<string, NodeTelemetry>();
            const freshKeys = new Set<string>();
            const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
            let sampled = false;
            for (const [addr, telem] of Object.entries(
              msg.nodes as Record<string, NodeTelemetry>,
            )) {
              next.set(addr, telem);
              freshKeys.add(addr);
              if (pushSample(historyRef.current, addr, telem.metrics, ts)) {
                sampled = true;
              }
            }
            for (const addr of [...historyRef.current.keys()]) {
              if (!freshKeys.has(addr)) {
                historyRef.current.delete(addr);
              }
            }
            if (sampled) {
              setHistoryVersion((v) => v + 1);
            }
            setLastUpdateAt(ts);
            const changed =
              freshKeys.size !== knownKeysRef.current.size ||
              [...freshKeys].some((k) => !knownKeysRef.current.has(k));
            knownKeysRef.current = freshKeys;
            setTelemetry(next);
            if (changed) {
              setTelemetryKeysVersion((v) => v + 1);
            }
            if (msg.meta) {
              setNodeMeta((prev) =>
                reconcileMeta(prev, msg.meta as Record<string, NodeMeta>, true),
              );
            }
            if (msg.cityMeta) {
              setCityMeta((prev) =>
                reconcileMeta(prev, msg.cityMeta as Record<string, CityMeta>, true),
              );
            }
            // Replaced wholesale: a city that stopped reporting must lose its host sample.
            setCityMetrics(
              new Map(Object.entries((msg.cityMetrics ?? {}) as Record<string, CityMetrics>)),
            );
            break;
          }
          case "update": {
            const updateNodes = msg.nodes as Record<string, Partial<NodeTelemetry>>;
            const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
            let hasNewKeys = false;
            let sampled = false;
            for (const [addr, partial] of Object.entries(updateNodes)) {
              if (!knownKeysRef.current.has(addr)) {
                knownKeysRef.current.add(addr);
                hasNewKeys = true;
              }
              if (pushSample(historyRef.current, addr, partial.metrics, ts)) {
                sampled = true;
              }
            }
            if (sampled) {
              setHistoryVersion((v) => v + 1);
            }
            setLastUpdateAt(ts);
            setTelemetry((prev) => mergeTelemetryUpdate(prev, updateNodes));
            if (hasNewKeys) {
              setTelemetryKeysVersion((v) => v + 1);
            }
            if (msg.meta) {
              setNodeMeta((prev) =>
                reconcileMeta(prev, msg.meta as Record<string, NodeMeta>, false),
              );
            }
            if (msg.cityMeta) {
              setCityMeta((prev) =>
                reconcileMeta(prev, msg.cityMeta as Record<string, CityMeta>, false),
              );
            }
            if (msg.cityMetrics) {
              setCityMetrics((prev) => {
                const next = new Map(prev);
                for (const [id, m] of Object.entries(
                  msg.cityMetrics as Record<string, CityMetrics>,
                )) {
                  next.set(id, m);
                }
                return next;
              });
            }
            break;
          }
          case "logs": {
            ingestLogs(msg.entries);
            break;
          }
          case "logs-result": {
            const pending = pendingQueriesRef.current.get(msg.requestId);
            if (!pending) {
              break; // timed out, or arrived after a reconnect
            }
            pendingQueriesRef.current.delete(msg.requestId);
            clearTimeout(pending.timer);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              ingestLogs(msg.entries);
              pending.resolve(msg.entries);
            }
            break;
          }
          case "status": {
            setProviders(msg.providers);
            break;
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      failPendingQueries("connection closed");
      if (!mountedRef.current) {
        return;
      }
      setConnected(false);
      wsRef.current = null;

      // Jittered exponential backoff
      const attempt = retriesRef.current++;
      const base = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      const jitter = base * 0.3 * Math.random();
      setTimeout(connectWs, base + jitter);
    };

    ws.onerror = () => {
      setWsError("WebSocket connection failed");
    };
  }, [proxyUrl, ingestLogs, failPendingQueries]);

  useEffect(() => {
    mountedRef.current = true;
    connectWs();
    return () => {
      mountedRef.current = false;
      failPendingQueries("unmounted");
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs, failPendingQueries]);

  const subscribeLogs = useCallback((nodes?: string[], levels?: LogEntry["level"][]) => {
    wsRef.current?.send(JSON.stringify({ type: "subscribe:logs", nodes, levels }));
  }, []);

  const unsubscribeLogs = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "unsubscribe:logs" }));
  }, []);

  const requestSnapshot = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "request:snapshot" }));
  }, []);

  const queryLogs = useCallback(
    (opts: LogQueryOptions) =>
      new Promise<LogEntry[]>((resolve, reject) => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) {
          reject(new Error("not connected"));
          return;
        }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingQueriesRef.current.delete(requestId);
          reject(new Error("timed out"));
        }, QUERY_TIMEOUT_MS);
        pendingQueriesRef.current.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ type: "query:logs", requestId, ...opts }));
      }),
    [],
  );

  const canQueryLogs = useMemo(
    () => providers.some((p) => p.capabilities?.includes("logs-query")),
    [providers],
  );

  return {
    telemetry,
    nodeMeta,
    cityMeta,
    cityMetrics,
    telemetryKeysVersion,
    connected,
    error: wsError,
    providers,
    logs,
    history: historyRef.current,
    historyVersion,
    lastUpdateAt,
    requestSnapshot,
    subscribeLogs,
    unsubscribeLogs,
    canQueryLogs,
    queryLogs,
  };
}
