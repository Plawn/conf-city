import type { LogEntry } from "../../protocol.ts";

/** Longest message kept from a backend line; the rest is cut. */
export const MESSAGE_MAX = 500;

/**
 * A node whose logs we want, described with everything the Swarm topology already knows.
 * Log backends identify containers by Swarm labels, so carrying the raw ids here is what
 * lets a backend attribute a line to the right (node, service) pair.
 */
export interface LogTarget {
  /** "cityId/nodeId" — the Conf City address the entries must end up under. */
  address: string;
  /** Swarm node hostname. */
  cityId: string;
  /** Swarm service name. */
  nodeId: string;
  serviceId: string;
  /** Swarm node id, as found in `com.docker.swarm.node.id` labels. */
  swarmNodeId: string;
}

export interface LogQuery {
  targets: LogTarget[];
  /** epoch ms, inclusive */
  since: number;
  /** epoch ms, exclusive */
  until: number;
  /** cap on the whole query, across every target */
  limit: number;
}

export interface LogSource {
  readonly kind: string;
  /**
   * true when the source can answer an arbitrary past range. The Docker API only serves a
   * tail, so only a real log store sets this — it is what gates the "logs-query" capability.
   */
  readonly supportsHistory: boolean;
  fetch(q: LogQuery): Promise<LogEntry[]>;
}
