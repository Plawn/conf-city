// Dummy log lines: per-type templates filled with random numbers.

import type { LogEntry } from "../../protocol.ts";
import type { NodeInfo } from "./metrics.ts";

const logTemplates: Record<string, string[]> = {
  app: [
    "Request processed in {latency}ms",
    "Connection pool: {n} active",
    "Cache hit ratio: {pct}%",
    "Deployed version v1.{v}.{p}",
    "Health check passed",
    "Rate limit reached for client {ip}",
  ],
  db: [
    "Query executed in {latency}ms",
    "Vacuum completed on table users",
    "Replication lag: {n}ms",
    "Connection count: {n}",
    "Checkpoint completed",
    "Slow query detected: SELECT * FROM orders",
  ],
  cache: [
    "Evicted {n} keys (LRU)",
    "Memory usage: {pct}%",
    "Connected clients: {n}",
    "Keyspace: {n} keys",
    "Snapshot saved to disk",
  ],
  queue: [
    "Queue depth: {n} messages",
    "Consumer connected: worker-{v}",
    "Message delivered in {latency}ms",
    "Dead-letter queue: {n} messages",
    "Channel created: events.{v}",
  ],
};

export function fillTemplate(tpl: string): string {
  return tpl
    .replace("{latency}", String(Math.floor(Math.random() * 200)))
    .replace("{n}", String(Math.floor(Math.random() * 100)))
    .replace("{pct}", String(Math.floor(Math.random() * 100)))
    .replace("{v}", String(Math.floor(Math.random() * 20)))
    .replace("{p}", String(Math.floor(Math.random() * 100)))
    .replace("{ip}", `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`);
}

/** Level for a uniform draw `r` in [0, 1): 5% error, 10% warn, 15% debug, the rest info. */
export function randomLogLevel(r: number): LogEntry["level"] {
  if (r < 0.05) {
    return "error";
  }
  if (r < 0.15) {
    return "warn";
  }
  if (r < 0.3) {
    return "debug";
  }
  return "info";
}

/** Log collector: 2–4 lines per tick, from random nodes. */
export function createLogs(allNodes: NodeInfo[]): () => LogEntry[] {
  return () => {
    const entries: LogEntry[] = [];
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const node = allNodes[Math.floor(Math.random() * allNodes.length)]!;
      const templates = logTemplates[node.type] ?? logTemplates.app!;
      const tpl = templates[Math.floor(Math.random() * templates.length)]!;
      const level = randomLogLevel(Math.random());
      entries.push({
        timestamp: Date.now(),
        node: node.address,
        level,
        message: fillTemplate(tpl),
      });
    }
    return entries;
  };
}
