import { describe, expect, test } from "bun:test";
import { PITCH, ROAD_OFFSET } from "@/layout/constants";
import { pointInPolygon, vecKey } from "@/layout/geometry";
import { layoutCity } from "@/layout/layoutCity";
import { buildRing } from "@/layout/ringRoad";
import { buildRoadNetwork } from "@/layout/roads";
import type { RoadNetwork, Vec2 } from "@/layout/types";
import { city, grid, intraLinks } from "../fixtures/layout";

function build(cityId: string, nodes: ReturnType<typeof city>, pairs: [string, string][] = []) {
  const links = intraLinks(cityId, pairs);
  const layout = layoutCity(cityId, nodes, [], links);
  return { layout, roads: buildRoadNetwork(layout, links) };
}

const isCorner = (p: Vec2) =>
  Number.isInteger((p[0] - ROAD_OFFSET) / PITCH) && Number.isInteger((p[1] - ROAD_OFFSET) / PITCH);

function ringKeys(roads: RoadNetwork): Set<string> {
  return new Set(roads.ring.map(vecKey));
}

/** Every segment end is a ring vertex, a lattice corner, or a bridgehead. */
function checkEnds(roads: RoadNetwork) {
  const ring = ringKeys(roads);
  const heads = new Set(
    roads.roundabouts.filter((r) => ring.has(vecKey(r.center))).map((r) => vecKey(r.center)),
  );
  for (const s of roads.segments) {
    expect(s.points.length).toBeGreaterThanOrEqual(2);
    for (const p of [s.points[0]!, s.points[s.points.length - 1]!]) {
      expect(ring.has(vecKey(p)) || isCorner(p) || heads.has(vecKey(p))).toBe(true);
    }
    if (!s.ring) {
      for (let k = 0; k + 1 < s.points.length; k++) {
        const a = s.points[k]!;
        const b = s.points[k + 1]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        expect(len).toBeGreaterThan(0);
      }
    }
  }
}

describe("buildRoadNetwork", () => {
  test("is deterministic", () => {
    const a = build("c", grid("c", 3, 3), [
      ["n00", "n22"],
      ["n20", "n02"],
      ["n10", "n12"],
    ]);
    const b = build("c", grid("c", 3, 3), [
      ["n00", "n22"],
      ["n20", "n02"],
      ["n10", "n12"],
    ]);
    expect(JSON.stringify([...a.roads.routes])).toBe(JSON.stringify([...b.roads.routes]));
    expect(JSON.stringify(a.roads.segments)).toBe(JSON.stringify(b.roads.segments));
  });

  test("a lone building gets a ring and one driveway onto it", () => {
    const { roads } = build("solo", city("solo", ["only"]));
    expect(roads.ring.length).toBeGreaterThan(8);
    expect(roads.segments.filter((s) => s.ring).length).toBeGreaterThanOrEqual(2);
    expect(roads.segments.filter((s) => !s.ring)).toHaveLength(0);
    const route = roads.routes.get("ring:only");
    expect(route).toBeDefined();
    const end = route!.points[route!.points.length - 1]!;
    expect(ringKeys(roads).has(vecKey(end))).toBe(true);
    expect(roads.driveways).toHaveLength(1);
    expect(roads.driveways[0]!.mouth).toEqual(end);
  });

  test("two linked buildings share a street and need no ring driveway", () => {
    const { roads } = build("pair", city("pair", ["a", "b"]), [["a", "b"]]);
    const route = roads.routes.get("pair/a->pair/b");
    expect(route).toBeDefined();
    // Too thin for a lattice street: the link rides the ring between two driveways.
    const ring = ringKeys(roads);
    for (const p of route!.points.slice(1, -1)) {
      expect(ring.has(vecKey(p))).toBe(true);
    }
    expect([...roads.routes.keys()].filter((k) => k.startsWith("ring:"))).toHaveLength(0);
    expect(roads.segments.filter((s) => s.ring).length).toBeGreaterThanOrEqual(2);
    expect(roads.driveways).toHaveLength(2);
    checkEnds(roads);
  });

  test("every building without a link is connected to the ring", () => {
    const nodes = grid("g", 3, 2);
    const { roads } = build("g", nodes, [["n00", "n10"]]);
    const ring = ringKeys(roads);
    for (const n of nodes) {
      if (n.id === "n00" || n.id === "n10") {
        expect(roads.routes.has(`ring:${n.id}`)).toBe(false);
        continue;
      }
      const route = roads.routes.get(`ring:${n.id}`);
      expect(route).toBeDefined();
      expect(route!.points).toHaveLength(2);
      expect(ring.has(vecKey(route!.points[1]!))).toBe(true);
    }
    checkEnds(roads);
  });

  test("streets stay inside the ring and roundabouts sit on street ends", () => {
    const nodes = grid("big", 4, 4);
    const pairs: [string, string][] = [
      ["n00", "n33"],
      ["n30", "n03"],
      ["n10", "n13"],
      ["n20", "n23"],
      ["n01", "n31"],
      ["n02", "n32"],
      ["n11", "n22"],
    ];
    const { layout, roads } = build("big", nodes, pairs);
    const { inner } = buildRing(layout.nodes);
    const ring = ringKeys(roads);
    for (const s of roads.segments) {
      if (s.ring) {
        continue;
      }
      for (const p of s.points) {
        if (ring.has(vecKey(p))) {
          continue; // the stub end on the ring
        }
        expect(pointInPolygon(p, inner)).toBe(true);
      }
    }
    const ends = new Set<string>();
    for (const s of roads.segments) {
      ends.add(vecKey(s.points[0]!));
      ends.add(vecKey(s.points[s.points.length - 1]!));
    }
    expect(roads.roundabouts.length).toBeGreaterThan(0);
    for (const r of roads.roundabouts) {
      expect(ends.has(vecKey(r.center))).toBe(true);
    }
    // Every lattice step is exactly one cell long.
    for (const s of roads.segments) {
      if (s.ring) {
        continue;
      }
      for (let k = 0; k + 1 < s.points.length; k++) {
        const a = s.points[k]!;
        const b = s.points[k + 1]!;
        if (!isCorner(a) || !isCorner(b)) {
          continue;
        }
        expect(Math.abs(b[0] - a[0]) + (Math.abs(b[1] - a[1]) % PITCH)).toBe(Math.abs(b[0] - a[0]));
      }
    }
    checkEnds(roads);
  });

  test("every route rides drawn asphalt: consecutive points are a segment step, a driveway, or on the ring", () => {
    const nodes = grid("ride", 3, 3);
    const { roads } = build("ride", nodes, [
      ["n00", "n22"],
      ["n20", "n02"],
      ["n10", "n12"],
    ]);
    const steps = new Set<string>();
    for (const s of roads.segments) {
      for (let k = 0; k + 1 < s.points.length; k++) {
        steps.add(`${vecKey(s.points[k]!)}|${vecKey(s.points[k + 1]!)}`);
        steps.add(`${vecKey(s.points[k + 1]!)}|${vecKey(s.points[k]!)}`);
      }
    }
    const mouths = new Set(roads.driveways.map((d) => vecKey(d.mouth)));
    for (const route of roads.routes.values()) {
      const pts = route.points;
      // Ends: building centre → driveway mouth.
      expect(mouths.has(vecKey(pts[1]!))).toBe(true);
      for (let k = 1; k + 1 < pts.length - 1; k++) {
        const a = pts[k]!;
        const b = pts[k + 1]!;
        // A mouth sits mid-edge: the step around it is half a lattice edge.
        if (mouths.has(vecKey(a)) || mouths.has(vecKey(b))) {
          continue;
        }
        expect(steps.has(`${vecKey(a)}|${vecKey(b)}`)).toBe(true);
      }
    }
  });
});
