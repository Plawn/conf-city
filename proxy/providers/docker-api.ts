// Shared Docker Engine API client, used by both the Swarm provider (manager side,
// topology + limits) and the per-node agent (container stats).

const DOCKER_API_VERSION = "v1.45";

export class DockerClient {
  private readonly baseUrl: string;
  private readonly socketPath?: string;

  constructor() {
    const dockerHost = process.env.DOCKER_HOST;

    if (dockerHost?.startsWith("tcp://") || dockerHost?.startsWith("http")) {
      this.baseUrl = dockerHost.replace(/^tcp:\/\//, "http://").replace(/\/$/, "");
    } else {
      this.socketPath = dockerHost?.startsWith("/") ? dockerHost : "/var/run/docker.sock";
      this.baseUrl = "http://localhost";
    }
  }

  private url(path: string) {
    return `${this.baseUrl}/${DOCKER_API_VERSION}${path}`;
  }

  private fetchOpts() {
    if (this.socketPath) {
      return { unix: this.socketPath };
    }
    return {};
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(this.url(path), this.fetchOpts());
    if (!res.ok) {
      throw new Error(`Docker API ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  /** Fetch raw response (for log streams with binary framing). */
  async getRaw(path: string): Promise<Response> {
    const res = await fetch(this.url(path), this.fetchOpts());
    if (!res.ok) {
      throw new Error(`Docker API ${path}: ${res.status} ${res.statusText}`);
    }
    return res;
  }
}

export interface ContainerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage: number;
    online_cpus: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage: number;
  };
  memory_stats: {
    usage: number;
    limit: number;
    /** cgroup memory.stat — used to subtract the page cache from `usage` (like `docker stats`). */
    stats?: Record<string, number>;
  };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

/**
 * Working-set memory, as `docker stats` reports it: raw cgroup usage minus the
 * reclaimable page cache (`inactive_file` on cgroup v2, `total_inactive_file` on v1).
 * Without this, cache-heavy services (Postgres…) always read at 100% of their limit.
 */
export function memUsedBytes(mem: ContainerStats["memory_stats"]): number {
  const usage = mem.usage || 0;
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  return Math.max(0, usage - cache);
}

/** Per-container previous sample, to derive rates between two collections. */
export interface ContainerSample {
  at: number;
  /** Cumulative CPU counters, in nanoseconds. */
  cpuTotal: number;
  cpuSystem: number;
  /** Cumulative network counters, in bytes. False when the container reports no interface. */
  hasNet: boolean;
  rx: number;
  tx: number;
}

export function sampleOf(stats: ContainerStats, at: number): ContainerSample {
  let hasNet = false;
  let rx = 0;
  let tx = 0;
  if (stats.networks) {
    hasNet = true;
    for (const iface of Object.values(stats.networks)) {
      rx += iface.rx_bytes || 0;
      tx += iface.tx_bytes || 0;
    }
  }
  return {
    at,
    cpuTotal: stats.cpu_stats?.cpu_usage?.total_usage ?? 0,
    cpuSystem: stats.cpu_stats?.system_cpu_usage ?? 0,
    hasNet,
    rx,
    tx,
  };
}

/**
 * CPU percentage (100 = one full core) between two cumulative samples.
 *
 * Derived from our own successive polls rather than from the payload's `precpu_stats`:
 * the stats endpoint is queried with `one-shot=true`, which returns no previous sample
 * (`precpu_stats.system_cpu_usage` is absent), so the in-payload delta silently yields
 * NaN. Dropping one-shot would make Docker sample twice internally, blocking ~1s per
 * container. Returns null on the first poll or when the counters went backwards
 * (container restarted).
 */
export function cpuPercentBetween(
  prev: ContainerSample,
  cur: ContainerSample,
  onlineCpus: number,
): number | null {
  const cpuDelta = cur.cpuTotal - prev.cpuTotal;
  const sysDelta = cur.cpuSystem - prev.cpuSystem;
  if (!(sysDelta > 0) || cpuDelta < 0) {
    return null;
  }
  return (cpuDelta / sysDelta) * (onlineCpus || 1) * 100;
}

/** Network throughput in kbps between two cumulative samples. */
export function netKbpsBetween(
  prev: ContainerSample,
  cur: ContainerSample,
): { rxKbps: number; txKbps: number } | null {
  const dt = (cur.at - prev.at) / 1000;
  if (!cur.hasNet || !prev.hasNet || dt <= 0) {
    return null;
  }
  return {
    rxKbps: (Math.max(0, cur.rx - prev.rx) * 8) / 1000 / dt,
    txKbps: (Math.max(0, cur.tx - prev.tx) * 8) / 1000 / dt,
  };
}
