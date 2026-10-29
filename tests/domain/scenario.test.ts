import { describe, expect, test } from "bun:test";
import { BLAST_SEC } from "@/domain/blast";
import {
  activeKey,
  dateAt,
  parseScenario,
  presenceAt,
  presenceOf,
  ScenarioError,
  scenarioFromSnapshot,
} from "@/domain/scenario";
import example from "../../public/scenarios/example.json";

describe("scenario", () => {
  const tl = parseScenario(example);

  test("maps dates onto the video clock", () => {
    expect(tl.totalSec).toBe(3 + 40 + 5);
    expect(dateAt(tl, 0).toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(dateAt(tl, 43).toISOString().slice(0, 10)).toBe("2026-12-31");
    const cache = tl.nodes.get("paris-1/cache")!;
    expect(dateAt(tl, cache.from).toISOString().slice(0, 10)).toBe("2026-03-01");
  });

  test("a node never outlives its city, a link never outlives its ends", () => {
    const db = tl.nodes.get("london-1/analytics-db")!;
    expect(db.from).toBeGreaterThanOrEqual(tl.cities.get("london-1")!.from);
    const worker = tl.nodes.get("paris-1/worker")!;
    const link = tl.linkSpans.get("paris-1/queue->paris-1/worker")!;
    expect(link.from).toBe(worker.from);
  });

  test("presence rises, holds and falls over the ramp", () => {
    const span = { from: 10, to: 20 };
    expect(presenceOf(span, 9.9, 1)).toBe(0);
    expect(presenceOf(span, 10.5, 1)).toBeCloseTo(0.5);
    expect(presenceOf(span, 15, 1)).toBe(1);
    expect(presenceOf(span, 20.25, 1)).toBeCloseTo(0.75);
    expect(presenceOf(span, 21, 1)).toBe(0);
  });

  test("the active key only changes when something enters or leaves", () => {
    const legacy = tl.nodes.get("paris-1/legacy-db")!;
    const a = presenceAt(tl, 1);
    const b = presenceAt(tl, 1.5);
    expect(activeKey(a)).toBe(activeKey(b));
    expect(presenceAt(tl, legacy.to + 0.5).nodes.has("paris-1/legacy-db")).toBe(true);
    expect(presenceAt(tl, legacy.to + 0.5).blasts.get("paris-1/legacy-db")).toBeCloseTo(0.5);
    expect(presenceAt(tl, legacy.to + BLAST_SEC + 0.01).nodes.has("paris-1/legacy-db")).toBe(false);
    expect(presenceAt(tl, 1).cities.has("london-1")).toBe(false);
  });

  test("events are sorted and name their city", () => {
    const ats = tl.events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((x, y) => x - y));
    expect(tl.events.find((e) => e.id === "london-1")?.what).toBe("city");
    expect(tl.events.find((e) => e.id === "paris-1/legacy-db")?.kind).toBe("remove");
  });

  test("rejects broken scenarios with readable errors", () => {
    expect(() => parseScenario({ ...example, start: "nope" })).toThrow(ScenarioError);
    const bad = structuredClone(example);
    bad.cities[0]!.nodes[0]!.links = ["ghost"];
    expect(() => parseScenario(bad)).toThrow(/ghost/);
  });
});

describe("scenarioFromSnapshot", () => {
  const snapshot = {
    meta: {
      "a/web": { type: "app", label: "Web", group: "front", links: ["a/db", "b/api", "a/agent"] },
      "a/db": { type: "db", links: [] },
      "a/agent": { type: "app", hidden: true },
      "b/api": { type: "lambda", ingress: true },
    },
    cityMeta: { a: { label: "Server A", memMb: 8192 } },
  };
  const scn = scenarioFromSnapshot(snapshot, {
    title: "T",
    start: "2026-01-01",
    end: "2026-12-31",
  });

  test("groups nodes by city, drops hidden ones and their links", () => {
    expect(scn.cities.map((c) => [c.id, c.name, c.nodes.map((n) => n.id)])).toEqual([
      ["a", "Server A", ["db", "web"]],
      ["b", "b", ["api"]],
    ]);
    expect(scn.cities[0]!.nodes[1]!.links).toEqual(["db"]);
    expect(scn.links).toEqual([{ from: "a/web", to: "b/api" }]);
  });

  test("keeps capacity and flags, falls back to app for unknown types", () => {
    expect(scn.cities[0]!.meta?.memMb).toBe(8192);
    expect(scn.cities[1]!.nodes[0]).toMatchObject({ type: "app", label: "api", ingress: true });
  });

  test("round-trips through parseScenario", () => {
    const tl = parseScenario(scn);
    expect(tl.world.cities).toHaveLength(2);
    expect(tl.links).toHaveLength(2);
  });
});
