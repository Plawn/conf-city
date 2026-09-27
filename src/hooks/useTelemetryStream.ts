import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetricSample } from "../domain/telemetry";
import { appendLogs } from "../domain/telemetryMerge";
import type { CityMeta, CityMetrics, LogEntry, NodeMeta, NodeTelemetry } from "../domain/types";
import { handleMessage, type MessageContext } from "./telemetryMessages";
import type { LogQueryOptions, PendingQuery, ProviderInfo, TelemetryState } from "./telemetryTypes";

const DEFAULT_PROXY_URL =
  typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/frontend`
    : "ws://localhost:4001/ws/frontend";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** Longer than the proxy's own fan-out timeout, so its answer wins over our giving up. */
const QUERY_TIMEOUT_MS = 15_000;

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
  const pendingQueriesRef = useRef(new Map<string, PendingQuery>());

  /**
   * Fold a batch into `logs`. Live tail and backfill overlap by design — the provider
   * re-reads a little of each window, and a backfill necessarily covers what the tail
   * already delivered — so entries are deduplicated by content and re-sorted.
   */
  const ingestLogs = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) {
      return;
    }
    setLogs((prev) => appendLogs(prev, entries));
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

    const ctx: MessageContext = {
      historyRef,
      knownKeysRef,
      pendingQueriesRef,
      setTelemetry,
      setNodeMeta,
      setCityMeta,
      setCityMetrics,
      setTelemetryKeysVersion,
      setHistoryVersion,
      setLastUpdateAt,
      setProviders,
      ingestLogs,
    };

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
        handleMessage(JSON.parse(ev.data), ctx);
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
