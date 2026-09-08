import type {
  CityMeta,
  CityMetrics,
  LivenessStatus,
  LogEntry,
  MetricSnapshot,
  NodeMeta,
  NodeTelemetry,
  ProviderCapability,
} from "./protocol.ts";

const MAX_LOG_ENTRIES = 1000;
const STALENESS_MS = 30_000;

export interface ProviderInfo {
  id: string;
  providerType: string;
  connectedAt: number;
  capabilities: ProviderCapability[];
}

export interface LogQueryFilter {
  nodes?: string[];
  levels?: LogEntry["level"][];
  since: number;
  until: number;
  limit: number;
}

export class TelemetryStore {
  nodes = new Map<string, NodeTelemetry>();
  nodeMeta = new Map<string, NodeMeta>();
  cityMeta = new Map<string, CityMeta>();
  cityMetrics = new Map<string, CityMetrics>();
  logs: LogEntry[] = [];
  providers = new Map<string, ProviderInfo>();

  // Track which nodes changed since last flush
  private changedNodes = new Set<string>();
  private changedMeta = new Set<string>();
  private changedCityMeta = new Set<string>();
  private changedCityMetrics = new Set<string>();

  applyMetrics(batch: Record<string, MetricSnapshot>) {
    const now = Date.now();
    for (const [addr, metrics] of Object.entries(batch)) {
      const existing = this.nodes.get(addr);
      if (existing) {
        existing.metrics = { ...existing.metrics, ...metrics };
        existing.lastSeen = now;
      } else {
        this.nodes.set(addr, { liveness: "unknown", metrics, lastSeen: now });
      }
      this.changedNodes.add(addr);
    }
  }

  applyLiveness(batch: Record<string, LivenessStatus>) {
    const now = Date.now();
    for (const [addr, liveness] of Object.entries(batch)) {
      const existing = this.nodes.get(addr);
      if (existing) {
        existing.liveness = liveness;
        existing.lastSeen = now;
      } else {
        this.nodes.set(addr, { liveness, metrics: {}, lastSeen: now });
      }
      this.changedNodes.add(addr);
    }
  }

  /** Host-level usage for a city — always a fresh sample, so every batch is a change. */
  applyCityMetrics(batch: Record<string, CityMetrics>) {
    for (const [cityId, metrics] of Object.entries(batch)) {
      this.cityMetrics.set(cityId, metrics);
      this.changedCityMetrics.add(cityId);
    }
  }

  getCityMetricsSnapshot(): Record<string, CityMetrics> {
    return Object.fromEntries(this.cityMetrics);
  }

  flushCityMetricsChanges(): Record<string, CityMetrics> | undefined {
    if (this.changedCityMetrics.size === 0) {
      return undefined;
    }
    const out: Record<string, CityMetrics> = {};
    for (const id of this.changedCityMetrics) {
      const m = this.cityMetrics.get(id);
      if (m) {
        out[id] = m;
      }
    }
    this.changedCityMetrics.clear();
    return out;
  }

  applyNodeMeta(batch: Record<string, NodeMeta>) {
    for (const [addr, meta] of Object.entries(batch)) {
      const existing = this.nodeMeta.get(addr);
      if (existing && JSON.stringify(existing) === JSON.stringify(meta)) {
        continue;
      }
      this.nodeMeta.set(addr, meta);
      this.changedMeta.add(addr);
    }
  }

  applyCityMeta(batch: Record<string, CityMeta>) {
    for (const [cityId, meta] of Object.entries(batch)) {
      const existing = this.cityMeta.get(cityId);
      if (existing && JSON.stringify(existing) === JSON.stringify(meta)) {
        continue;
      }
      this.cityMeta.set(cityId, meta);
      this.changedCityMeta.add(cityId);
    }
  }

  getCityMetaSnapshot(): Record<string, CityMeta> {
    return Object.fromEntries(this.cityMeta);
  }

  flushCityMetaChanges(): Record<string, CityMeta> | undefined {
    if (this.changedCityMeta.size === 0) {
      return undefined;
    }
    const out: Record<string, CityMeta> = {};
    for (const id of this.changedCityMeta) {
      const m = this.cityMeta.get(id);
      if (m) {
        out[id] = m;
      }
    }
    this.changedCityMeta.clear();
    return out;
  }

  appendLogs(entries: LogEntry[]) {
    this.logs = this.logs.concat(entries);
    // Ring buffer: trim from head
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
    }
  }

  /**
   * Read back the ring buffer. Only a shallow fallback — it holds the last
   * MAX_LOG_ENTRIES lines across every node, not real history — but it lets a frontend
   * that opens the panel see what already arrived, instead of an empty pane.
   */
  queryLogs(filter: LogQueryFilter): LogEntry[] {
    const nodes = filter.nodes?.length ? new Set(filter.nodes) : undefined;
    const levels = filter.levels?.length ? new Set(filter.levels) : undefined;
    const out: LogEntry[] = [];
    for (const e of this.logs) {
      if (e.timestamp < filter.since || e.timestamp >= filter.until) {
        continue;
      }
      if (nodes && !nodes.has(e.node)) {
        continue;
      }
      if (levels && !levels.has(e.level)) {
        continue;
      }
      out.push(e);
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    // Keep the most recent when over the cap.
    return out.length > filter.limit ? out.slice(-filter.limit) : out;
  }

  registerProvider(info: ProviderInfo) {
    this.providers.set(info.id, info);
  }

  removeProvider(id: string) {
    this.providers.delete(id);
  }

  getMetaSnapshot(): Record<string, NodeMeta> {
    return Object.fromEntries(this.nodeMeta);
  }

  flushMetaChanges(): Record<string, NodeMeta> | undefined {
    if (this.changedMeta.size === 0) {
      return undefined;
    }
    const out: Record<string, NodeMeta> = {};
    for (const addr of this.changedMeta) {
      const m = this.nodeMeta.get(addr);
      if (m) {
        out[addr] = m;
      }
    }
    this.changedMeta.clear();
    return out;
  }

  getSnapshot(): Record<string, NodeTelemetry> {
    const out: Record<string, NodeTelemetry> = {};
    for (const [addr, telem] of this.nodes) {
      out[addr] = { ...telem, metrics: { ...telem.metrics } };
    }
    return out;
  }

  /** Returns node changes since last flush and clears the delta buffer. */
  flushChanges(): Record<string, Partial<NodeTelemetry>> {
    const nodes: Record<string, Partial<NodeTelemetry>> = {};
    for (const addr of this.changedNodes) {
      const t = this.nodes.get(addr);
      if (t) {
        nodes[addr] = { ...t, metrics: { ...t.metrics } };
      }
    }
    this.changedNodes.clear();
    return nodes;
  }

  /** Mark nodes as "unknown" if not seen within STALENESS_MS. */
  checkStaleness() {
    const now = Date.now();
    for (const [addr, telem] of this.nodes) {
      if (telem.liveness !== "unknown" && now - telem.lastSeen > STALENESS_MS) {
        telem.liveness = "unknown";
        this.changedNodes.add(addr);
      }
    }
  }

  /** Remove nodes not seen for more than the given duration. */
  purgeStale(maxAgeMs: number) {
    const now = Date.now();
    for (const [cityId, m] of this.cityMetrics) {
      // A host sample that stopped arriving must not keep passing for the live machine.
      if (now - m.at > maxAgeMs) {
        this.cityMetrics.delete(cityId);
        this.changedCityMetrics.delete(cityId);
      }
    }
    for (const [addr, telem] of this.nodes) {
      if (now - telem.lastSeen > maxAgeMs) {
        this.nodes.delete(addr);
        this.nodeMeta.delete(addr);
        this.changedNodes.delete(addr);
        this.changedMeta.delete(addr);
      }
    }
  }
}
