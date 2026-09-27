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

/** A collector's answer: the data to send, or null/undefined to skip that tick. */
type Collected<T> = T | null | undefined;
/** Sync or async collector. */
export type Collect<T> = () => Collected<T> | Promise<Collected<T>>;

/** A periodic job, run only while connected. */
interface Schedule {
  name: string;
  ms: number;
  run: () => void | Promise<void>;
  /** A run is in flight — per schedule, so a reconnect cannot stack a second one. */
  busy: boolean;
}

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
   * Each collector runs on a fixed interval while connected, sync or async; a slow run
   * skips the ticks it overlaps. Return the data to send, or null/undefined to skip that tick.
   */
  intervals?: {
    metrics?: { ms: number; collect: Collect<Record<string, MetricSnapshot>> };
    liveness?: { ms: number; collect: Collect<Record<string, LivenessStatus>> };
    logs?: { ms: number; collect: Collect<LogEntry[]> };
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
  private schedules: Schedule[] = [];
  private _connected = false;

  constructor(config: ProviderConfig) {
    this.config = config;
    const { metrics, liveness, logs } = config.intervals ?? {};
    if (metrics) {
      this.every("metrics", metrics.ms, async () => {
        const data = await metrics.collect();
        if (data) {
          this.sendMetrics(data);
        }
      });
    }
    if (liveness) {
      this.every("liveness", liveness.ms, async () => {
        const data = await liveness.collect();
        if (data) {
          this.sendLiveness(data);
        }
      });
    }
    if (logs) {
      this.every("logs", logs.ms, async () => {
        const data = await logs.collect();
        if (data && data.length > 0) {
          this.sendLogs(data);
        }
      });
    }
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

  /**
   * Run `run` every `ms` while connected. A run still in flight skips the next ticks
   * instead of stacking; a throw is logged and the schedule keeps going.
   */
  every(name: string, ms: number, run: () => void | Promise<void>) {
    const schedule: Schedule = { name, ms, run, busy: false };
    this.schedules.push(schedule);
    if (this._connected) {
      this.startTimer(schedule);
    }
  }

  /** Stop on SIGTERM/SIGINT; `beforeStop` releases what the caller owns first. */
  stopOnSignals(tag: string, beforeStop?: () => void) {
    const shutdown = () => {
      console.log(`[${tag}] Shutting down...`);
      beforeStop?.();
      this.stop();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
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
    for (const schedule of this.schedules) {
      this.startTimer(schedule);
    }
  }

  private startTimer(schedule: Schedule) {
    this.timers.push(
      setInterval(async () => {
        if (schedule.busy || !this._connected) {
          return;
        }
        schedule.busy = true;
        try {
          await schedule.run();
        } catch (err) {
          console.error(`[${this.config.id}] ${schedule.name} error:`, err);
        } finally {
          schedule.busy = false;
        }
      }, schedule.ms),
    );
  }

  private clearTimers() {
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
  }
}
