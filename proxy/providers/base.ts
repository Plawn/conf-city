import type {
  CityMeta,
  CityMetrics,
  LivenessStatus,
  LogEntry,
  MetricSnapshot,
  NodeMeta,
  ProviderCapability,
  ProxyToProviderMessage,
} from "../protocol.ts";

/** A historical log query relayed by the proxy. */
export interface LogQueryRequest {
  nodes?: string[];
  since: number;
  until: number;
  limit: number;
}

// ── Configuration ──

export interface ProviderConfig {
  /** Unique provider ID (e.g. "prometheus-prod-1") */
  id: string;
  /** Provider type (e.g. "prometheus", "otel", "cloudwatch") */
  type: string;
  /** What this provider sends */
  capabilities: ProviderCapability[];
  /** Proxy WebSocket URL. Default: ws://localhost:4001/ws/provider */
  proxyUrl?: string;
  /** Delay before reconnecting after disconnect. Default: 3000 */
  reconnectMs?: number;

  /**
   * Optional interval-based collectors.
   * Each collector runs on a fixed interval while connected.
   * Return the data to send, or null/undefined to skip that tick.
   */
  intervals?: {
    metrics?: {
      ms: number;
      collect: () => Record<string, MetricSnapshot> | null | undefined;
    };
    liveness?: {
      ms: number;
      collect: () => Record<string, LivenessStatus> | null | undefined;
    };
    logs?: {
      ms: number;
      collect: () => LogEntry[] | null | undefined;
    };
  };

  /**
   * Answer a historical log query. Declare the "logs-query" capability to receive these —
   * without it the proxy never routes one here.
   */
  onQueryLogs?: (q: LogQueryRequest) => Promise<LogEntry[]>;

  /** Called when connected to the proxy. */
  onConnected?: () => void;
  /** Called when disconnected from the proxy. */
  onDisconnected?: () => void;
}

// ── Base Provider ──

export class BaseProvider {
  private config: ProviderConfig;
  private ws: WebSocket | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private _connected = false;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  get connected() {
    return this._connected;
  }

  get id() {
    return this.config.id;
  }

  // ── Lifecycle ──

  /** Connect to the proxy and start sending data. */
  start() {
    this.connect();
  }

  /** Disconnect and stop all intervals. */
  stop() {
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  // ── Push methods (call anytime while connected) ──

  sendMetrics(nodes: Record<string, MetricSnapshot>, cities?: Record<string, CityMetrics>) {
    this.send({ type: "provider:metrics", nodes, cities });
  }

  sendLiveness(nodes: Record<string, LivenessStatus>) {
    this.send({ type: "provider:liveness", nodes });
  }

  sendLogs(entries: LogEntry[]) {
    this.send({ type: "provider:logs", entries });
  }

  sendLogsResult(requestId: string, entries: LogEntry[], error?: string) {
    this.send({ type: "provider:logs-result", requestId, entries, error });
  }

  sendNodeMeta(nodes: Record<string, NodeMeta>, cities?: Record<string, CityMeta>) {
    this.send({ type: "provider:node-meta", nodes, cities });
  }

  // ── Internals ──

  private get proxyUrl() {
    return this.config.proxyUrl || process.env.PROXY_URL || "ws://localhost:4001/ws/provider";
  }

  private get reconnectMs() {
    return this.config.reconnectMs ?? 3_000;
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private connect() {
    console.log(`[${this.config.id}] Connecting to ${this.proxyUrl}...`);
    const ws = new WebSocket(this.proxyUrl);
    this.ws = ws;

    ws.onopen = () => {
      this._connected = true;
      console.log(`[${this.config.id}] Connected`);

      // Send hello
      this.send({
        type: "provider:hello",
        id: this.config.id,
        providerType: this.config.type,
        capabilities: this.config.capabilities,
      });

      // Start interval collectors
      this.startTimers();

      this.config.onConnected?.();
    };

    ws.onmessage = (event) => {
      let msg: ProxyToProviderMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        console.error(`[${this.config.id}] Received malformed message`);
        return;
      }
      if (msg.type === "query:logs") {
        this.handleQueryLogs(msg);
      }
    };

    ws.onclose = () => {
      this._connected = false;
      this.clearTimers();
      console.log(`[${this.config.id}] Disconnected, reconnecting in ${this.reconnectMs}ms...`);
      this.config.onDisconnected?.();
      setTimeout(() => this.connect(), this.reconnectMs);
    };

    ws.onerror = (e) => {
      console.error(`[${this.config.id}] WebSocket error:`, e);
    };
  }

  private async handleQueryLogs(msg: ProxyToProviderMessage) {
    const { requestId, nodes, since, until, limit } = msg;
    if (!this.config.onQueryLogs) {
      this.sendLogsResult(requestId, [], "provider cannot answer log queries");
      return;
    }
    try {
      const entries = await this.config.onQueryLogs({ nodes, since, until, limit });
      this.sendLogsResult(requestId, entries);
    } catch (err) {
      // The proxy waits on every provider it queried — always answer, even to say we failed.
      this.sendLogsResult(requestId, [], String(err));
    }
  }

  private startTimers() {
    const { intervals } = this.config;
    if (!intervals) {
      return;
    }

    if (intervals.metrics) {
      const { ms, collect } = intervals.metrics;
      this.timers.push(
        setInterval(() => {
          const data = collect();
          if (data) {
            this.sendMetrics(data);
          }
        }, ms),
      );
    }

    if (intervals.liveness) {
      const { ms, collect } = intervals.liveness;
      this.timers.push(
        setInterval(() => {
          const data = collect();
          if (data) {
            this.sendLiveness(data);
          }
        }, ms),
      );
    }

    if (intervals.logs) {
      const { ms, collect } = intervals.logs;
      this.timers.push(
        setInterval(() => {
          const data = collect();
          if (data && data.length > 0) {
            this.sendLogs(data);
          }
        }, ms),
      );
    }
  }

  private clearTimers() {
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
  }
}
