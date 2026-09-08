import type { LogEntry } from "../../protocol.ts";
import type { DockerClient } from "../docker-api.ts";
import { getLogLevel } from "./level.ts";
import type { LogQuery, LogSource, LogTarget } from "./types.ts";

/** Services polled per tick — the Docker API is one request per service, so this bounds the fan-out. */
const SAMPLE_SIZE = 5;
const TAIL = 20;
const MESSAGE_MAX = 500;

/** Parse Docker multiplexed log stream (8-byte header per frame). */
export function parseDockerLogStream(buf: ArrayBuffer): string[] {
  const view = new DataView(buf);
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;

  while (offset + 8 <= buf.byteLength) {
    const frameSize = view.getUint32(offset + 4, false);
    offset += 8;
    if (offset + frameSize > buf.byteLength) {
      break;
    }

    const text = decoder.decode(new Uint8Array(buf, offset, frameSize));
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
      }
    }
    offset += frameSize;
  }

  return lines;
}

/**
 * Logs straight from the Docker Engine API, via the manager.
 *
 * `/services/{id}/logs` aggregates every replica of a service and does not say which node
 * emitted a line, so entries are attributed to one arbitrary city. It also only serves a
 * tail: there is no way to ask it for a past window, hence `supportsHistory = false`.
 * Both limitations are why a real log store is worth pointing at instead.
 */
export class DockerLogSource implements LogSource {
  readonly kind = "docker";
  readonly supportsHistory = false;

  private docker: DockerClient;
  /** Per-service cursor, epoch ms of the last poll. */
  private lastSince = new Map<string, number>();

  constructor(docker: DockerClient) {
    this.docker = docker;
  }

  async fetch(q: LogQuery): Promise<LogEntry[]> {
    if (q.targets.length === 0) {
      return [];
    }

    // One entry per service: a service replicated over several nodes yields several targets.
    const byService = new Map<string, LogTarget>();
    for (const t of q.targets) {
      if (!byService.has(t.serviceId)) {
        byService.set(t.serviceId, t);
      }
    }

    // Drop cursors of services that left the topology.
    for (const id of [...this.lastSince.keys()]) {
      if (!byService.has(id)) {
        this.lastSince.delete(id);
      }
    }

    const sample = [...byService.values()]
      .toSorted(() => Math.random() - 0.5)
      .slice(0, SAMPLE_SIZE);
    const entries: LogEntry[] = [];

    await Promise.allSettled(
      sample.map(async (target) => {
        const cursor = this.lastSince.get(target.serviceId) ?? q.since;
        const since = Math.floor(cursor / 1000);

        try {
          const res = await this.docker.getRaw(
            `/services/${target.serviceId}/logs?stdout=true&stderr=true&timestamps=true&since=${since}&tail=${TAIL}`,
          );
          const buf = await res.arrayBuffer();

          for (const line of parseDockerLogStream(buf)) {
            // Docker timestamps: 2024-01-15T10:30:00.000000000Z message
            const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)/);
            const timestamp = tsMatch ? new Date(tsMatch[1]!).getTime() : Date.now();
            const message = (tsMatch ? tsMatch[2]! : line).slice(0, MESSAGE_MAX);
            entries.push({
              timestamp,
              node: target.address,
              level: getLogLevel(message),
              message,
            });
          }
          // Only advance on success: a failed poll must retry its window, not skip it.
          this.lastSince.set(target.serviceId, q.until);
        } catch {
          // Service may have been removed between the topology refresh and this poll.
        }
      }),
    );

    return entries.length > q.limit ? entries.slice(-q.limit) : entries;
  }
}
