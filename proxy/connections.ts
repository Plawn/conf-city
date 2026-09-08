import type { ServerWebSocket } from "bun";
import { mergeLogs } from "./logKey.ts";
import type { FrontendMessage, LogEntry, ProviderMessage, QueryLogs } from "./protocol.ts";
import type { TelemetryStore } from "./state.ts";

/**
 * How long we wait for every queried provider before answering with what we have.
 * Must exceed a source's own HTTP deadline (10s for VictoriaLogs), or we would settle
 * empty just before its answer lands — and stay under the frontend's 15s give-up.
 */
const QUERY_TIMEOUT_MS = 12_000;
const DEFAULT_QUERY_LIMIT = 1_000;

export interface WSData {
  role: "provider" | "frontend";
  id: string;
  // Frontend log subscription
  logSubscribed?: boolean;
  logNodes?: string[];
  logLevels?: Set<LogEntry["level"]>;
}

/** A log query fanned out to providers, waiting for their answers. */
interface PendingQuery {
  frontend: ServerWebSocket<WSData>;
  requestId: string;
  limit: number;
  batches: LogEntry[][];
  waiting: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

export class ConnectionManager {
  store: TelemetryStore;
  private providers = new Map<string, ServerWebSocket<WSData>>();
  private frontends = new Map<string, ServerWebSocket<WSData>>();
  private pending = new Map<string, PendingQuery>();
  private nextId = 0;

  constructor(store: TelemetryStore) {
    this.store = store;
  }

  assignId(): string {
    return `conn-${++this.nextId}`;
  }

  addProvider(ws: ServerWebSocket<WSData>) {
    this.providers.set(ws.data.id, ws);
  }

  addFrontend(ws: ServerWebSocket<WSData>) {
    this.frontends.set(ws.data.id, ws);
  }

  remove(ws: ServerWebSocket<WSData>) {
    if (ws.data.role === "provider") {
      this.providers.delete(ws.data.id);
      this.store.removeProvider(ws.data.id);
      // A provider that dies mid-query must not keep its queries waiting for it.
      for (const q of [...this.pending.values()]) {
        if (q.waiting.delete(ws.data.id) && q.waiting.size === 0) {
          this.settleQuery(q);
        }
      }
      this.broadcastStatus();
    } else {
      this.frontends.delete(ws.data.id);
      for (const [id, q] of [...this.pending]) {
        if (q.frontend === ws) {
          clearTimeout(q.timer);
          this.pending.delete(id);
        }
      }
    }
  }

  handleProviderMessage(ws: ServerWebSocket<WSData>, msg: ProviderMessage) {
    switch (msg.type) {
      case "provider:hello":
        this.store.registerProvider({
          id: msg.id,
          providerType: msg.providerType,
          connectedAt: Date.now(),
          capabilities: msg.capabilities,
        });
        // Update the ws data id to match provider's declared id
        this.providers.delete(ws.data.id);
        ws.data.id = msg.id;
        this.providers.set(msg.id, ws);
        console.log(
          `Provider registered: ${msg.id} (${msg.providerType}) — capabilities: ${msg.capabilities.join(", ")}`,
        );
        this.broadcastStatus();
        break;
      case "provider:metrics":
        this.store.applyMetrics(msg.nodes);
        if (msg.cities) {
          this.store.applyCityMetrics(msg.cities);
        }
        break;
      case "provider:liveness":
        this.store.applyLiveness(msg.nodes);
        break;
      case "provider:logs":
        this.store.appendLogs(msg.entries);
        this.forwardLogs(msg.entries);
        break;
      case "provider:logs-result":
        this.collectQueryResult(ws.data.id, msg.requestId, msg.entries, msg.error);
        break;
      case "provider:node-meta":
        this.store.applyNodeMeta(msg.nodes);
        if (msg.cities) {
          this.store.applyCityMeta(msg.cities);
        }
        break;
    }
  }

  handleFrontendMessage(ws: ServerWebSocket<WSData>, msg: FrontendMessage) {
    switch (msg.type) {
      case "subscribe:logs":
        ws.data.logSubscribed = true;
        ws.data.logNodes = msg.nodes;
        ws.data.logLevels = msg.levels ? new Set(msg.levels) : undefined;
        break;
      case "unsubscribe:logs":
        ws.data.logSubscribed = false;
        ws.data.logNodes = undefined;
        ws.data.logLevels = undefined;
        break;
      case "query:logs":
        this.startLogQuery(ws, msg);
        break;
      case "request:snapshot":
        this.sendSnapshot(ws);
        break;
    }
  }

  sendSnapshot(ws: ServerWebSocket<WSData>) {
    ws.send(
      JSON.stringify({
        type: "snapshot",
        nodes: this.store.getSnapshot(),
        meta: this.store.getMetaSnapshot(),
        cityMeta: this.store.getCityMetaSnapshot(),
        cityMetrics: this.store.getCityMetricsSnapshot(),
        timestamp: Date.now(),
      }),
    );
  }

  broadcastSnapshot() {
    const payload = JSON.stringify({
      type: "snapshot",
      nodes: this.store.getSnapshot(),
      meta: this.store.getMetaSnapshot(),
      cityMeta: this.store.getCityMetaSnapshot(),
      cityMetrics: this.store.getCityMetricsSnapshot(),
      timestamp: Date.now(),
    });
    for (const ws of this.frontends.values()) {
      ws.send(payload);
    }
  }

  broadcastDelta() {
    const nodes = this.store.flushChanges();
    const meta = this.store.flushMetaChanges();
    const cityMeta = this.store.flushCityMetaChanges();
    const cityMetrics = this.store.flushCityMetricsChanges();
    if (Object.keys(nodes).length === 0 && !meta && !cityMeta && !cityMetrics) {
      return;
    }
    const payload = JSON.stringify({
      type: "update",
      nodes,
      meta,
      cityMeta,
      cityMetrics,
      timestamp: Date.now(),
    });
    for (const ws of this.frontends.values()) {
      ws.send(payload);
    }
  }

  broadcastStatus() {
    const providers = [...this.store.providers.values()];
    const payload = JSON.stringify({ type: "status", providers });
    for (const ws of this.frontends.values()) {
      ws.send(payload);
    }
  }

  // ── Historical log queries ──

  /**
   * Fan a backfill request out to every provider that can answer range queries.
   * Providers only push a tail, so without one of them the best we can do is the
   * proxy's own ring buffer.
   */
  private startLogQuery(ws: ServerWebSocket<WSData>, msg: QueryLogs) {
    const until = msg.until ?? Date.now();
    const limit = Math.min(msg.limit ?? DEFAULT_QUERY_LIMIT, DEFAULT_QUERY_LIMIT);

    const capable = [...this.store.providers.values()]
      .filter((p) => p.capabilities.includes("logs-query"))
      .map((p) => this.providers.get(p.id))
      .filter((w): w is ServerWebSocket<WSData> => w !== undefined);

    if (capable.length === 0) {
      const entries = this.store.queryLogs({
        nodes: msg.nodes,
        levels: msg.levels,
        since: msg.since,
        until,
        limit,
      });
      ws.send(
        JSON.stringify({
          type: "logs-result",
          requestId: msg.requestId,
          entries,
          fromCache: true,
        }),
      );
      return;
    }

    const query: PendingQuery = {
      frontend: ws,
      requestId: msg.requestId,
      limit,
      batches: [],
      waiting: new Set(capable.map((w) => w.data.id)),
      timer: setTimeout(() => {
        const q = this.pending.get(msg.requestId);
        if (q) {
          this.settleQuery(q);
        }
      }, QUERY_TIMEOUT_MS),
    };
    this.pending.set(msg.requestId, query);

    const payload = JSON.stringify({
      type: "query:logs",
      requestId: msg.requestId,
      nodes: msg.nodes,
      since: msg.since,
      until,
      limit,
    });
    for (const w of capable) {
      w.send(payload);
    }
  }

  private collectQueryResult(
    providerId: string,
    requestId: string,
    entries: LogEntry[],
    error?: string,
  ) {
    const q = this.pending.get(requestId);
    if (!q) {
      return; // already settled by timeout, or the frontend went away
    }
    if (error) {
      console.warn(`[proxy] ${providerId} log query failed: ${error}`);
    } else {
      q.batches.push(entries);
    }
    q.waiting.delete(providerId);
    if (q.waiting.size === 0) {
      this.settleQuery(q);
    }
  }

  private settleQuery(q: PendingQuery) {
    clearTimeout(q.timer);
    this.pending.delete(q.requestId);
    const merged = mergeLogs(...q.batches);
    // Keep the newest when several providers overflow the cap together.
    const entries = merged.length > q.limit ? merged.slice(-q.limit) : merged;
    q.frontend.send(JSON.stringify({ type: "logs-result", requestId: q.requestId, entries }));
  }

  private forwardLogs(entries: LogEntry[]) {
    for (const ws of this.frontends.values()) {
      if (!ws.data.logSubscribed) {
        continue; // not subscribed
      }
      const filtered = entries.filter((e) => {
        if (ws.data.logNodes?.length && !ws.data.logNodes.includes(e.node)) {
          return false;
        }
        if (ws.data.logLevels?.size && !ws.data.logLevels.has(e.level)) {
          return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        ws.send(JSON.stringify({ type: "logs", entries: filtered }));
      }
    }
  }
}
