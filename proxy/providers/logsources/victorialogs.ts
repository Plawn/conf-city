import type { LogEntry } from "../../protocol.ts";
import { getLogLevel } from "./level.ts";
import { type LogQuery, type LogSource, type LogTarget, MESSAGE_MAX } from "./types.ts";

/**
 * Fields written by the Docker log collector (Vector's `docker_logs` source, and anything
 * else that forwards container labels verbatim). They are ordinary fields, not stream
 * fields, so filtering on them costs a scan — see docs/logs-backends.md if that ever hurts.
 */
const SERVICE_FIELD = "label.com.docker.swarm.service.id";
const NODE_FIELD = "label.com.docker.swarm.node.id";

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

  constructor() {
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

  private buildQuery(q: LogQuery): string {
    const serviceIds = [...new Set(q.targets.map((t) => t.serviceId))];
    const filters = [`${quote(SERVICE_FIELD)}:in(${serviceIds.map(quote).join(",")})`];
    if (this.extraFilter) {
      filters.push(`(${this.extraFilter})`);
    }

    return [
      filters.join(" AND "),
      // `limit` without a sort returns an arbitrary subset of the window, not the newest
      // lines. Sort first, cut second — then flip back to ascending when parsing.
      "| sort by (_time desc)",
      `| limit ${q.limit}`,
      `| fields _time, _msg, ${quote(SERVICE_FIELD)}, ${quote(NODE_FIELD)}`,
    ].join(" ");
  }

  private parse(body: string, targets: LogTarget[]): LogEntry[] {
    // Exact (node, service) pair — the whole point of reading from a store instead of the
    // manager's aggregated service log.
    const byPair = new Map<string, string>();
    // Fallback when a replica moved between the last topology refresh and this query.
    const byService = new Map<string, LogTarget>();
    for (const t of targets) {
      byPair.set(`${t.swarmNodeId}|${t.serviceId}`, t.address);
      if (!byService.has(t.serviceId)) {
        byService.set(t.serviceId, t);
      }
    }
    // Node id → hostname, learnt from the targets themselves: enough to place a line whose
    // service has since moved to a node we do know about.
    const hostnameOf = new Map(targets.map((t) => [t.swarmNodeId, t.cityId]));

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

      const serviceId = row[SERVICE_FIELD];
      const swarmNodeId = row[NODE_FIELD];
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
