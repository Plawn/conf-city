import type { ProxyMessage } from "@proxy/protocol";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MetricSample } from "../domain/telemetry";
import {
  mergeCityMetrics,
  mergeTelemetryUpdate,
  pushSample,
  reconcileMeta,
} from "../domain/telemetryMerge";
import type { CityMeta, CityMetrics, LogEntry, NodeMeta, NodeTelemetry } from "../domain/types";
import type { PendingQuery, ProviderInfo } from "./telemetryTypes";

type Setter<T> = Dispatch<SetStateAction<T>>;

/** The hook's state setters and refs a proxy message may touch. */
export interface MessageContext {
  historyRef: RefObject<Map<string, MetricSample[]>>;
  knownKeysRef: RefObject<Set<string>>;
  pendingQueriesRef: RefObject<Map<string, PendingQuery>>;
  setTelemetry: Setter<Map<string, NodeTelemetry>>;
  setNodeMeta: Setter<Map<string, NodeMeta>>;
  setCityMeta: Setter<Map<string, CityMeta>>;
  setCityMetrics: Setter<Map<string, CityMetrics>>;
  setTelemetryKeysVersion: Setter<number>;
  setHistoryVersion: Setter<number>;
  setLastUpdateAt: Setter<number | null>;
  setProviders: Setter<ProviderInfo[]>;
  ingestLogs: (entries: LogEntry[]) => void;
}

/** Applies one proxy → frontend message; setter call order is what React batches, keep it. */
export function handleMessage(msg: ProxyMessage, ctx: MessageContext): void {
  const {
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
  } = ctx;
  switch (msg.type) {
    case "snapshot": {
      const next = new Map<string, NodeTelemetry>();
      const freshKeys = new Set<string>();
      const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      let sampled = false;
      for (const [addr, telem] of Object.entries(msg.nodes as Record<string, NodeTelemetry>)) {
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
        setNodeMeta((prev) => reconcileMeta(prev, msg.meta as Record<string, NodeMeta>, true));
      }
      if (msg.cityMeta) {
        setCityMeta((prev) => reconcileMeta(prev, msg.cityMeta as Record<string, CityMeta>, true));
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
        setNodeMeta((prev) => reconcileMeta(prev, msg.meta as Record<string, NodeMeta>, false));
      }
      if (msg.cityMeta) {
        setCityMeta((prev) => reconcileMeta(prev, msg.cityMeta as Record<string, CityMeta>, false));
      }
      if (msg.cityMetrics) {
        setCityMetrics((prev) =>
          mergeCityMetrics(prev, msg.cityMetrics as Record<string, CityMetrics>),
        );
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
}
