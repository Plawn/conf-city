import { expect, test } from "bun:test";
import { filterLogs, LEVELS, RANGES, rangeMs } from "@/domain/logFilter";
import type { LogEntry } from "@/domain/types";

const entry = (level: LogEntry["level"], node: string, message: string): LogEntry => ({
  timestamp: 0,
  level,
  node,
  message,
});
const logs = [
  entry("error", "prod/api", "Connection refused"),
  entry("info", "prod/web", "GET /api 200"),
  entry("debug", "staging/API", "cache warm"),
];

test("levels filter exactly, everything passes with every level on", () => {
  expect(filterLogs(logs, new Set(LEVELS), "", "")).toEqual(logs);
  expect(filterLogs(logs, new Set(["error"]), "", "")).toEqual([logs[0]!]);
  expect(filterLogs(logs, new Set(), "", "")).toEqual([]);
});

test("the node filter and the search are case-insensitive substrings", () => {
  expect(filterLogs(logs, new Set(LEVELS), "API", "")).toEqual([logs[0]!, logs[2]!]);
  // The search matches the message or the node.
  expect(filterLogs(logs, new Set(LEVELS), "", "api")).toEqual(logs);
  expect(filterLogs(logs, new Set(LEVELS), "prod", "REFUSED")).toEqual([logs[0]!]);
});

test("a range maps to its width", () => {
  expect(rangeMs("1h")).toBe(3_600_000);
  expect(RANGES.map((r) => r.value)).toEqual(["15m", "1h", "24h"]);
});
