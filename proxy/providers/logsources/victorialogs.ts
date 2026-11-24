import type { LogEntry } from "../../protocol.ts";
import { getLogLevel } from "./level.ts";
import { type LogQuery, type LogSource, type LogTarget, MESSAGE_MAX } from "./types.ts";

/**
 * Where the collector puts the Swarm service and node of each line, and what it puts there.
 * - `vector`: container labels forwarded verbatim (Vector's `docker_logs`) — Swarm ids, in
 *   ordinary fields, so filtering costs a scan.
 * - `promtail`: docker_sd relabelled to `swarm_service` / `swarm_instance` — the service
 *   *name* and node *hostname*, as Loki labels, i.e. stream fields (cheap to filter).
 */
export interface LogSchema {
  serviceField: string;
  nodeField: string;
  /** "id": Swarm service/node ids. "name": service name and node hostname. */
  keys: "id" | "name";
  /** The service field is a stream field: filter with `{…}` instead of a scan. */
  stream: boolean;
}

const SCHEMAS: Record<string, LogSchema> = {
  vector: {
    serviceField: "label.com.docker.swarm.service.id",
    nodeField: "label.com.docker.swarm.node.id",
    keys: "id",
    stream: false,
  },
  promtail: {
    serviceField: "swarm_service",
    nodeField: "swarm_instance",
    keys: "name",
    stream: true,
  },
};

export function schemaFromEnv(env: Record<string, string | undefined> = process.env): LogSchema {
  const name = env.VICTORIALOGS_SCHEMA ?? "vector";
  let base = SCHEMAS[name];
  if (!base) {
    console.warn(`[logs] Unknown VICTORIALOGS_SCHEMA "${name}", using vector`);
    base = SCHEMAS.vector!;
  }
  return {
    ...base,
    serviceField: env.VICTORIALOGS_SERVICE_FIELD || base.serviceField,
    nodeField: env.VICTORIALOGS_NODE_FIELD || base.nodeField,
  };
}

/** The target's value in the schema's service / node field. */
function serviceKey(s: LogSchema, t: LogTarget): string {
  return s.keys === "id" ? t.serviceId : t.nodeId;
}
function nodeKey(s: LogSchema, t: LogTarget): string {
  return s.keys === "id" ? t.swarmNodeId : t.cityId;
}

const DEFAULT_URL = "http://victorialogs:9428";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Quote a value for a LogsQL string literal. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One row of the JSON-lines answer. Every value comes back as a string. */
type Row = Record<string, string | undefined>;

/**
 * Logs read from VictoriaLogs.
 *
 * Unlike the Docker API this knows which *node* emitted each line (the Swarm labels travel
 * with the log), so a service replicated over several machines lands under the right city
 * instead of an arbitrary one. It is also a real store, so it can answer a past range —
 * which is what backfill needs.
 */
export class VictoriaLogsSource implements LogSource {
  readonly kind = "victorialogs";
  readonly supportsHistory = true;

  private baseUrl: string;
  private timeoutMs: number;
  private extraFilter: string;
  private headers: Record<string, string>;
  private schema: LogSchema;

  constructor(schema: LogSchema = schemaFromEnv()) {
    this.schema = schema;
    this.baseUrl = (process.env.VICTORIALOGS_URL ?? DEFAULT_URL).replace(/\/+$/, "");
    this.timeoutMs = Number(process.env.VICTORIALOGS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.extraFilter = process.env.VICTORIALOGS_EXTRA_FILTER ?? "";

    this.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    // Multi-tenancy is carried by headers, not by the URL: "accountID:projectID".
    const tenant = process.env.VICTORIALOGS_TENANT;
    if (tenant) {
      const [account, project] = tenant.split(":");
      if (account) {
        this.headers.AccountID = account;
      }
      if (project) {
        this.headers.ProjectID = project;
      }
    }
  }

  async fetch(q: LogQuery): Promise<LogEntry[]> {
    if (q.targets.length === 0) {
      return [];
    }

    const res = await fetch(`${this.baseUrl}/select/logsql/query`, {
      method: "POST",
      headers: this.headers,
      body: new URLSearchParams({
        query: this.buildQuery(q),
        start: new Date(q.since).toISOString(),
        // `end` is exclusive, which is exactly the half-open window callers ask for:
        // adjacent polls neither drop nor duplicate a line on the boundary.
        end: new Date(q.until).toISOString(),
        limit: String(q.limit),
      }),
      // A stalled store must not hold up the query fan-out; the proxy is waiting on us.
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`VictoriaLogs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    return this.parse(await res.text(), q.targets);
  }

  buildQuery(q: LogQuery): string {
    const { serviceField, nodeField, stream } = this.schema;
    const values = [...new Set(q.targets.map((t) => serviceKey(this.schema, t)))].map(quote);
    const filters = [
      stream
        ? `{${serviceField} in(${values.join(",")})}`
        : `${quote(serviceField)}:in(${values.join(",")})`,
    ];
    if (this.extraFilter) {
      filters.push(`(${this.extraFilter})`);
    }

    return [
      filters.join(" AND "),
      // `limit` without a sort returns an arbitrary subset of the window, not the newest
      // lines. Sort first, cut second — then flip back to ascending when parsing.
      "| sort by (_time desc)",
      `| limit ${q.limit}`,
      `| fields _time, _msg, ${quote(serviceField)}, ${quote(nodeField)}`,
    ].join(" ");
  }

  parse(body: string, targets: LogTarget[]): LogEntry[] {
    const schema = this.schema;
    // Exact (node, service) pair — the whole point of reading from a store instead of the
    // manager's aggregated service log.
    const byPair = new Map<string, string>();
    // Fallback when a replica moved between the last topology refresh and this query.
    const byService = new Map<string, LogTarget>();
    for (const t of targets) {
      const svc = serviceKey(schema, t);
      byPair.set(`${nodeKey(schema, t)}|${svc}`, t.address);
      if (!byService.has(svc)) {
        byService.set(svc, t);
      }
    }
    // Node key → hostname, learnt from the targets themselves: enough to place a line whose
    // service has since moved to a node we do know about.
    const hostnameOf = new Map(targets.map((t) => [nodeKey(schema, t), t.cityId]));

    const entries: LogEntry[] = [];
    for (const line of body.split("\n")) {
      if (!line) {
        continue;
      }

      let row: Row;
      try {
        row = JSON.parse(line) as Row;
      } catch {
        continue; // truncated last line, or a non-JSON error tail
      }

      const serviceId = row[schema.serviceField];
      const swarmNodeId = row[schema.nodeField];
      if (!serviceId) {
        continue; // container outside Swarm — nothing to attribute it to
      }

      const address = resolveAddress(serviceId, swarmNodeId, byPair, byService, hostnameOf);
      if (!address) {
        continue;
      }

      const timestamp = row._time ? new Date(row._time).getTime() : NaN;
      if (!Number.isFinite(timestamp)) {
        continue;
      }

      const message = (row._msg ?? "").slice(0, MESSAGE_MAX);
      entries.push({ timestamp, node: address, level: getLogLevel(message), message });
    }

    // The store answers newest-first (and, without the sort above, in no order at all);
    // every consumer downstream expects oldest-first.
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  }
}

function resolveAddress(
  serviceId: string,
  swarmNodeId: string | undefined,
  byPair: Map<string, string>,
  byService: Map<string, LogTarget>,
  hostnameOf: Map<string, string>,
): string | undefined {
  if (swarmNodeId) {
    const exact = byPair.get(`${swarmNodeId}|${serviceId}`);
    if (exact) {
      return exact;
    }

    const hostname = hostnameOf.get(swarmNodeId);
    const service = byService.get(serviceId);
    if (hostname && service) {
      return `${hostname}/${service.nodeId}`;
    }
  }
  return byService.get(serviceId)?.address;
}
