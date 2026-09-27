import { describe, expect, test } from "bun:test";
import type { MetricSample } from "@/domain/telemetry";
import {
  HISTORY_LEN,
  mergeTelemetryUpdate,
  pushSample,
  reconcileMeta,
} from "@/domain/telemetryMerge";
import type { NodeMeta, NodeTelemetry } from "@/domain/types";

const telem = (cpu: number): NodeTelemetry => ({
  liveness: "healthy",
  lastSeen: 1,
  metrics: { cpu, memoryMb: 100 },
});

const meta = (label: string): NodeMeta => ({ type: "app", label });

describe("mergeTelemetryUpdate", () => {
  test("merges metrics over the existing entry in a new map", () => {
    const prev = new Map([["a/x", telem(10)]]);
    const next = mergeTelemetryUpdate(prev, { "a/x": { metrics: { cpu: 50 } } });
    expect(next).not.toBe(prev);
    expect(prev.get("a/x")!.metrics.cpu).toBe(10);
    expect(next.get("a/x")).toEqual({
      liveness: "healthy",
      lastSeen: 1,
      metrics: { cpu: 50, memoryMb: 100 },
    });
  });

  test("a new address starts unknown with the partial's fields", () => {
    const next = mergeTelemetryUpdate(new Map(), { "a/y": { liveness: "down" } });
    const y = next.get("a/y")!;
    expect(y.liveness).toBe("down");
    expect(y.metrics).toEqual({});
    expect(typeof y.lastSeen).toBe("number");
  });
});

describe("reconcileMeta", () => {
  test("keeps the same Map and entries when nothing changed", () => {
    const x = meta("X");
    const prev = new Map([["a/x", x]]);
    expect(reconcileMeta(prev, { "a/x": meta("X") }, true)).toBe(prev);
    expect(reconcileMeta(prev, { "a/x": meta("X") }, false)).toBe(prev);
  });

  test("a changed entry yields a new Map that reuses the unchanged entries", () => {
    const x = meta("X");
    const prev = new Map([
      ["a/x", x],
      ["a/y", meta("Y")],
    ]);
    const next = reconcileMeta(prev, { "a/x": meta("X"), "a/y": meta("Y2") }, true);
    expect(next).not.toBe(prev);
    expect(next.get("a/x")).toBe(x);
    expect(next.get("a/y")!.label).toBe("Y2");
  });

  test("replace drops absent entries; a delta keeps them", () => {
    const prev = new Map([
      ["a/x", meta("X")],
      ["a/y", meta("Y")],
    ]);
    expect([...reconcileMeta(prev, { "a/x": meta("X") }, true).keys()]).toEqual(["a/x"]);
    expect(reconcileMeta(prev, { "a/x": meta("X") }, false)).toBe(prev);
  });
});

describe("pushSample", () => {
  test("caps the history at HISTORY_LEN, dropping the oldest", () => {
    const history = new Map<string, MetricSample[]>();
    for (let t = 0; t < HISTORY_LEN + 5; t++) {
      expect(pushSample(history, "a/x", { cpu: t }, t)).toBe(true);
    }
    const buf = history.get("a/x")!;
    expect(buf).toHaveLength(HISTORY_LEN);
    expect(buf[0]!.t).toBe(5);
    expect(buf[buf.length - 1]!.t).toBe(HISTORY_LEN + 4);
  });

  test("nothing to sample leaves the history untouched", () => {
    const history = new Map<string, MetricSample[]>();
    expect(pushSample(history, "a/x", undefined, 0)).toBe(false);
    expect(pushSample(history, "a/x", { netRxKbps: 3 }, 0)).toBe(false);
    expect(history.size).toBe(0);
  });
});
