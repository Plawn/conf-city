import { describe, expect, test } from "bun:test";
import { vecKey } from "@/layout/geometry";
import { layoutWorld } from "@/layout/layoutWorld";
import type { Vec2 } from "@/layout/types";
import { cityWarp, densify } from "@/layout/warp";
import { grid, intraLinks } from "../fixtures/layout";

const SQUARE: Vec2[] = [
  [-30, -30],
  [30, -30],
  [30, 30],
  [-30, 30],
];

describe("cityWarp", () => {
  test("is deterministic and bends the inside", () => {
    const a = cityWarp("a", SQUARE);
    const b = cityWarp("a", SQUARE);
    const moved = [0, 6, 12].map((x) => a.apply([x, 3]));
    expect(moved).toEqual([0, 6, 12].map((x) => b.apply([x, 3])));
    expect(moved.some(([x, z], i) => Math.hypot(x - i * 6, z - 3) > 0.05)).toBe(true);
  });

  test("never moves the ring or anything outside it", () => {
    const w = cityWarp("a", SQUARE);
    for (const p of [...SQUARE, [0, -30], [30, 7], [50, 0], [-31, 4]] as Vec2[]) {
      expect(w.apply(p)).toEqual(p);
    }
  });

  test("bends gently: at most ~1.1 units and a few degrees", () => {
    const w = cityWarp("b", SQUARE);
    for (let x = -24; x <= 24; x += 3) {
      for (let z = -24; z <= 24; z += 3) {
        const [px, pz] = w.apply([x, z]);
        expect(Math.hypot(px - x, pz - z)).toBeLessThan(1.15);
        expect(Math.abs(w.angleAt([x, z]))).toBeLessThan(0.3);
      }
    }
  });
});

describe("densify", () => {
  test("a route and the street under it get the same vertices", () => {
    const street = densify([
      [3, 3],
      [3, 15],
      [15, 15],
    ]).map(vecKey);
    const route = densify([
      [3, 6],
      [3, 15],
      [9, 15],
    ]).map(vecKey);
    for (const k of route) {
      expect(street).toContain(k);
    }
    expect(
      densify([
        [0, 0],
        [5, 4],
      ] as Vec2[]),
    ).toEqual([
      [0, 0],
      [5, 4],
    ]);
  });
});

describe("bent city", () => {
  const PAIRS: [string, string][] = [
    ["n00", "n22"],
    ["n01", "n21"],
    ["n10", "n12"],
    ["n02", "n20"],
  ];
  const world = () => layoutWorld(["a"], grid("a", 3, 3), intraLinks("a", PAIRS));

  test("every route point is still a street vertex, roundabout, mouth or door", () => {
    const city = world().cities.get("a")!;
    const known = new Set<string>();
    for (const s of city.roads.segments) {
      for (const p of s.points) {
        known.add(vecKey(p));
      }
    }
    for (const r of city.roads.roundabouts) {
      known.add(vecKey(r.center));
    }
    for (const d of city.roads.driveways) {
      known.add(vecKey(d.mouth));
    }
    const centres = new Set(city.nodes.map((n) => `${n.position[0]},${n.position[2]}`));
    for (const route of city.roads.routes.values()) {
      for (const p of route.points) {
        const k = vecKey(p);
        expect(known.has(k) || centres.has(k)).toBe(true);
      }
    }
  });

  test("the ring is drawn exactly as before the bend", () => {
    const city = world().cities.get("a")!;
    const ringKeys = new Set(city.roads.ring.map(vecKey));
    for (const s of city.roads.segments.filter((s) => s.ring)) {
      for (const p of s.points) {
        expect(ringKeys.has(vecKey(p))).toBe(true);
      }
    }
  });
});
