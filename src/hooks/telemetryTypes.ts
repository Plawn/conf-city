import type { ProviderCapability } from "@proxy/protocol";
import type { MetricSample } from "../domain/telemetry";
import type { CityMeta, CityMetrics, LogEntry, NodeMeta, NodeTelemetry } from "../domain/types";

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

/** A `query:logs` waiting for its `logs-result`. */
export interface PendingQuery {
  resolve: (entries: LogEntry[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
