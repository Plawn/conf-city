import { expect, test } from "bun:test";
import { type BiomeId, DEFAULT_BIOME } from "@/domain/biome";
import { cityRows, topConsumers } from "@/domain/panelRows";
import type { City, MetricSnapshot, NodeTelemetry, PositionedNode } from "@/domain/types";

const node = (cityId: string, id: string): PositionedNode =>
  ({ cityId, id, label: id.toUpperCase(), type: "app", position: [0, 0, 0] }) as PositionedNode;
const tele = (
  liveness: NodeTelemetry["liveness"],
  metrics: MetricSnapshot = {},
): NodeTelemetry => ({
  liveness,
  metrics,
  lastSeen: 0,
});
const cities: City[] = [
  { id: "a", name: "A", nodes: [] },
  { id: "b", name: "B", nodes: [] },
];
const nodes = [node("a", "x"), node("a", "y"), node("a", "z"), node("b", "w")];

test("city rows count nodes and liveness, flag discovered cities and carry the biome", () => {
  const telemetry = new Map([
    ["a/x", tele("down")],
    ["a/y", tele("degraded")],
    ["a/z", tele("healthy")],
  ]);
  const layoutCities = new Map<string, { biome?: BiomeId }>([["a", { biome: DEFAULT_BIOME }]]);
  const [a, b] = cityRows(
    cities,
    nodes,
    telemetry,
    new Map(),
    new Map(),
    [{ id: "b" }],
    layoutCities,
  );
  expect(a).toMatchObject({ count: 3, down: 1, degraded: 1, isDiscovered: false });
  expect(a!.usage).toBeDefined();
  expect(a!.biome?.id).toBe(DEFAULT_BIOME);
  expect(b).toMatchObject({ count: 1, down: 0, degraded: 0, isDiscovered: true });
  expect(b!.usage).toBeUndefined();
  expect(b).not.toHaveProperty("biome");
});

test("top consumers rank visible nodes, normalised to their city's top one", () => {
  const telemetry = new Map([
    ["a/x", tele("healthy", { memoryMb: 400, memLimitMb: 800 })],
    ["a/y", tele("healthy", { memoryMb: 100 })],
    ["b/w", tele("healthy", { memoryMb: 900 })],
  ]);
  const rows = topConsumers(nodes, telemetry, new Set(["a"]), "health");
  expect(rows.map((r) => r.addr)).toEqual(["a/x", "a/y"]);
  expect(rows[0]).toMatchObject({ label: "X", value: 400, ratio: 1, saturation: 0.5 });
  expect(rows[1]!.ratio).toBeCloseTo(0.25, 9);
  expect(rows[1]!.saturation).toBeUndefined();
});

test("cpu saturation needs a limit, and at most five rows are kept", () => {
  const many = Array.from({ length: 7 }, (_, i) => node("a", `n${i}`));
  const telemetry = new Map(
    many.map((n, i) => [
      `a/${n.id}`,
      tele("healthy", { cpu: 10 * (i + 1), cpuLimit: i === 6 ? 2 : undefined }),
    ]),
  );
  const rows = topConsumers(many, telemetry, new Set(["a"]), "cpu");
  expect(rows).toHaveLength(5);
  expect(rows[0]).toMatchObject({ addr: "a/n6", value: 70, saturation: 0.35 });
  expect(rows[1]!.saturation).toBeUndefined();
});
