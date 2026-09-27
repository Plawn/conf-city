import { describe, expect, test } from "bun:test";
import { distToPolygon, distToPolyline, pointInPolygon } from "@/layout/geometry";
import { layoutWorld } from "@/layout/layoutWorld";
import type { CityLayout, Vec2 } from "@/layout/types";
import { SLOT_COUNT } from "@/layout/utilityPlot";
import { city, grid, interLink, intraLinks } from "../fixtures/layout";

/** Same clearances `utilityPlot.ts` enforces. */
const ROAD_CLEAR = 2.2;
const RING_CLEAR = 1.45;
const BUILDING_CLEAR = 3;

/** Everything the plot must never touch: asphalt, buildings, water. */
function expectPlotIsBuildable(layout: CityLayout) {
  const plot = layout.utilityPlot;
  expect(plot).toBeDefined();
  expect(plot!.slots).toHaveLength(SLOT_COUNT);
  // Every slot is ground an installation is put on, so every slot is checked —
  // the centre is only their middle.
  for (const slot of [{ center: plot!.center }, ...plot!.slots]) {
    expectSpotIsBuildable(layout, slot.center);
  }
}

function expectSpotIsBuildable(layout: CityLayout, at: Vec2) {
  expect(pointInPolygon(at, layout.outline)).toBe(true);
  // Dry land, and on the seaward side of the ring: a stretch of coast.
  expect(distToPolygon(at, layout.outline)).toBeGreaterThan(0.3);
  expect(distToPolygon(at, layout.outline)).toBeLessThan(4);

  for (const seg of layout.roads.segments) {
    if (seg.ring) {
      continue;
    }
    expect(distToPolyline(at, seg.points)).toBeGreaterThanOrEqual(ROAD_CLEAR);
  }
  for (const d of layout.roads.driveways) {
    expect(distToPolyline(at, [d.mouth, d.door])).toBeGreaterThanOrEqual(ROAD_CLEAR);
  }
  for (const r of layout.roads.roundabouts) {
    expect(Math.hypot(at[0] - r.center[0], at[1] - r.center[1])).toBeGreaterThanOrEqual(
      r.radius + ROAD_CLEAR,
    );
  }
  expect(distToPolygon(at, layout.roads.ring)).toBeGreaterThanOrEqual(RING_CLEAR - 1e-6);

  for (const n of layout.nodes) {
    const d = Math.hypot(at[0] - n.position[0], at[1] - n.position[2]);
    expect(d).toBeGreaterThanOrEqual(BUILDING_CLEAR);
  }
}

describe("placeUtilityPlot", () => {
  test("every island gets a buildable coastal plot", () => {
    const nodes = [...grid("a", 3, 3), ...grid("b", 2, 2)];
    const links = [
      ...intraLinks("a", [
        ["n00", "n22"],
        ["n20", "n02"],
      ]),
      ...intraLinks("b", [["n00", "n11"]]),
      interLink(["a", "n11"], ["b", "n00"]),
    ];
    const world = layoutWorld(["a", "b"], nodes, links);
    for (const layout of world.cities.values()) {
      expectPlotIsBuildable(layout);
    }
  });

  test("the plot faces the water: `shoreward` is a unit normal pointing at the coast", () => {
    const world = layoutWorld(["a"], grid("a", 3, 3), intraLinks("a", [["n00", "n22"]]));
    const layout = world.cities.get("a")!;
    const plot = layout.utilityPlot!;
    expect(Math.hypot(plot.shoreward[0], plot.shoreward[1])).toBeCloseTo(1, 6);

    const here = distToPolygon(plot.center, layout.outline);
    const ahead = distToPolygon(
      [plot.center[0] + plot.shoreward[0] * 0.5, plot.center[1] + plot.shoreward[1] * 0.5],
      layout.outline,
    );
    expect(ahead).toBeLessThan(here);
  });

  test("the plot keeps clear of the bridgeheads", () => {
    const nodes = [...grid("a", 3, 3), ...grid("b", 2, 2)];
    const world = layoutWorld(["a", "b"], nodes, [
      ...intraLinks("a", [["n00", "n22"]]),
      interLink(["a", "n11"], ["b", "n00"]),
    ]);
    const layout = world.cities.get("a")!;
    const head = world.bridges[0]!.waterSpan[0];
    const at = layout.utilityPlot!.center;
    expect(Math.hypot(at[0] - head[0], at[1] - head[1])).toBeGreaterThan(6);
  });

  test("the plot is deterministic", () => {
    const nodes = [...grid("a", 3, 3), ...grid("b", 2, 2)];
    const links = [...intraLinks("a", [["n00", "n22"]]), interLink(["a", "n11"], ["b", "n00"])];
    const once = layoutWorld(["a", "b"], nodes, links);
    const twice = layoutWorld(["a", "b"], nodes, links);
    for (const id of ["a", "b"]) {
      expect(twice.cities.get(id)!.utilityPlot).toEqual(once.cities.get(id)!.utilityPlot);
    }
  });

  test("the power station takes a double share of the waterfront", () => {
    const world = layoutWorld(["a"], grid("a", 3, 3), intraLinks("a", [["n00", "n22"]]));
    const [beacon, plant, tower, quay] = world.cities.get("a")!.utilityPlot!.slots;
    const gap = (p: { center: Vec2 }, q: { center: Vec2 }) =>
      Math.hypot(p.center[0] - q.center[0], p.center[1] - q.center[1]);
    // Neighbours of the plant sit 1.5 shares away, the last two only 1.
    expect(gap(beacon!, plant!)).toBeGreaterThan(gap(tower!, quay!) * 1.2);
    expect(gap(plant!, tower!)).toBeGreaterThan(gap(tower!, quay!) * 1.2);
  });

  test("a one-building island still gets its beacon", () => {
    const world = layoutWorld(["x"], city("x", ["one"]), []);
    expectPlotIsBuildable(world.cities.get("x")!);
  });

  test("a rugged coast gives the district a deeper band than a smooth one", () => {
    const nodes = grid("a", 3, 3);
    const links = intraLinks("a", [["n00", "n22"]]);
    const smooth = layoutWorld(["a"], nodes, links, [], new Map([["a", "harbour"]]));
    const rugged = layoutWorld(["a"], nodes, links, [], new Map([["a", "basalt"]]));
    expect(rugged.cities.get("a")!.utilityPlot!.room).toBeGreaterThan(
      smooth.cities.get("a")!.utilityPlot!.room,
    );
  });
});
