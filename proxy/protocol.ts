// Shared protocol types for WebSocket communication between provider, proxy, and frontend.
// No runtime dependencies — pure TypeScript interfaces.

// ── Telemetry types ──

export type LivenessStatus = "healthy" | "degraded" | "down" | "unknown";

export interface MetricSnapshot {
  cpu?: number; // 0-100
  memoryMb?: number;
  rps?: number;
  latencyMs?: number;
  errorRate?: number; // 0-1
  /** CPU cores allocated to the node (limit, else reservation). cpu / (cpuLimit*100) = saturation. */
  cpuLimit?: number;
  /** Memory limit in MB. memoryMb / memLimitMb = saturation. */
  memLimitMb?: number;
  /** Network throughput, kilobits per second. */
  netRxKbps?: number;
  netTxKbps?: number;
  custom?: Record<string, number>;
}

export interface NodeTelemetry {
  liveness: LivenessStatus;
  metrics: MetricSnapshot;
  lastSeen: number; // epoch ms
}

export interface LogEntry {
  timestamp: number;
  node: string; // "cityId/nodeId"
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface NodeMeta {
  type: string; // "app" | "db" | "cache" | "queue"
  label?: string;
  description?: string;
  /** Neighbourhood inside the city; nodes sharing a group are laid out together. */
  group?: string;
  /** Outgoing links, as full "cityId/nodeId" addresses. */
  links?: string[];
  /** true when links were inferred (env vars) rather than declared via labels. */
  linksInferred?: boolean;
  /** Do not render this node (agents, exporters…). */
  hidden?: boolean;
  /** Internet entry point: the service moves to the shore and becomes the island's port. */
  ingress?: boolean;
}

/** Capacity / identity of a city (a Swarm node, a cluster…). */
export interface CityMeta {
  label?: string;
  cpuCores?: number;
  memMb?: number;
  /** Island look requested by the provider (Swarm: node label `confcity.biome`); unknown ids are ignored. */
  biome?: string;
}

/**
 * Usage of the *machine* behind a city, measured on the host itself — not the sum of
 * its containers. The two differ by everything the container view cannot see: kernel,
 * dockerd, systemd, and any container outside the orchestrator.
 */
export interface CityMetrics {
  /** Cores busy on the host (1.5 = one and a half cores). */
  cpuUsedCores?: number;
  /** Memory in use on the host, MB (total - available, as `free` reports it). */
  memUsedMb?: number;
  /** 1-minute load average. */
  load1?: number;
  /** Root filesystem of the host, MB. Space, not I/O — a gauge, like memory. */
  diskUsedMb?: number;
  diskTotalMb?: number;
  /**
   * Block-device throughput of the whole machine, megabytes per second. Deliberately
   * not the kilobits of `netRxKbps`: disks are read in MB/s everywhere else.
   */
  diskReadMbPerSec?: number;
  diskWriteMbPerSec?: number;
  /** When the sample was taken, epoch ms. */
  at: number;
}

// ── Provider → Proxy messages ──

/**
 * What a provider can do. "logs" = pushes live entries; "logs-query" = can additionally
 * answer historical range queries (a log store behind it, not just a tail).
 */
export type ProviderCapability = "metrics" | "liveness" | "logs" | "logs-query";

export interface ProviderHello {
  type: "provider:hello";
  id: string;
  providerType: string; // "dummy" | "prometheus" | "otel" …
  capabilities: ProviderCapability[];
}

export interface ProviderMetrics {
  type: "provider:metrics";
  nodes: Record<string, MetricSnapshot>; // key = "cityId/nodeId"
  /** Host-level usage, key = cityId. Only agents that can read the host report this. */
  cities?: Record<string, CityMetrics>;
}

export interface ProviderLiveness {
  type: "provider:liveness";
  nodes: Record<string, LivenessStatus>; // key = "cityId/nodeId"
}

export interface ProviderLogs {
  type: "provider:logs";
  entries: LogEntry[];
}

/** Answer to a ProxyQueryLogs, correlated by requestId. */
export interface ProviderLogsResult {
  type: "provider:logs-result";
  requestId: string;
  entries: LogEntry[];
  error?: string;
}

export interface ProviderNodeMeta {
  type: "provider:node-meta";
  nodes: Record<string, NodeMeta>; // key = "cityId/nodeId"
  cities?: Record<string, CityMeta>; // key = cityId
}

export type ProviderMessage =
  | ProviderHello
  | ProviderMetrics
  | ProviderLiveness
  | ProviderLogs
  | ProviderLogsResult
  | ProviderNodeMeta;

// ── Proxy → Provider messages ──

/** Historical log query fanned out to every provider declaring "logs-query". */
export interface ProxyQueryLogs {
  type: "query:logs";
  requestId: string;
  nodes?: string[]; // "cityId/nodeId" addresses, empty = all
  since: number; // epoch ms, inclusive
  until: number; // epoch ms, exclusive
  limit: number;
}

export type ProxyToProviderMessage = ProxyQueryLogs;

// ── Proxy → Frontend messages ──

export interface SnapshotMessage {
  type: "snapshot";
  nodes: Record<string, NodeTelemetry>; // full state
  meta: Record<string, NodeMeta>;
  cityMeta: Record<string, CityMeta>;
  cityMetrics: Record<string, CityMetrics>;
  timestamp: number;
}

export interface UpdateMessage {
  type: "update";
  nodes: Record<string, Partial<NodeTelemetry>>; // delta
  meta?: Record<string, NodeMeta>; // only when changed
  cityMeta?: Record<string, CityMeta>; // only when changed
  cityMetrics?: Record<string, CityMetrics>; // only when changed
  timestamp: number;
}

export interface LogsMessage {
  type: "logs";
  entries: LogEntry[];
}

export interface StatusMessage {
  type: "status";
  providers: {
    id: string;
    providerType: string;
    connectedAt: number;
    capabilities: ProviderCapability[];
  }[];
}

export interface LogsResultMessage {
  type: "logs-result";
  requestId: string;
  entries: LogEntry[];
  error?: string;
  /** Served from the proxy ring buffer because no provider can answer range queries. */
  fromCache?: boolean;
}

export type ProxyMessage =
  | SnapshotMessage
  | UpdateMessage
  | LogsMessage
  | LogsResultMessage
  | StatusMessage;

// ── Frontend → Proxy commands ──

export interface SubscribeLogs {
  type: "subscribe:logs";
  nodes?: string[]; // filter by node addresses, empty = all
  levels?: LogEntry["level"][]; // filter by level, empty = all
}

export interface UnsubscribeLogs {
  type: "unsubscribe:logs";
}

/** Backfill request: ask for logs already in the past, before/while live tailing. */
export interface QueryLogs {
  type: "query:logs";
  requestId: string;
  nodes?: string[];
  levels?: LogEntry["level"][];
  since: number; // epoch ms, inclusive
  until?: number; // epoch ms, exclusive — defaults to now
  limit?: number;
}

export interface RequestSnapshot {
  type: "request:snapshot";
}

export type FrontendMessage = SubscribeLogs | UnsubscribeLogs | QueryLogs | RequestSnapshot;
