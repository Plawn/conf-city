import { describe, expect, test } from "bun:test";
import { BIOMES } from "@/domain/biome";
import { NODE_STYLE } from "@/domain/nodeStyle";
import { pointInPolygon } from "@/layout/geometry";
import { layoutWorld } from "@/layout/layoutWorld";
import { scatterProps } from "@/layout/props";
import type { CityLayout, RoadClass, Vec2 } from "@/layout/types";
import { grid, intraLinks } from "../fixtures/layout";

/** Whatever the renderer's widths are, the scatter must honour the ones it is given. */
const CLEARANCE: Record<RoadClass, number> = { street: 0.85, avenue: 1.1, boulevard: 1.35 };

function layout(): CityLayout {
  const nodes = grid("a", 3, 3);
  const world = layoutWorld(
    ["a"],
    nodes,
    intraLinks("a", [
      ["n00", "n21"],
      ["n01", "n12"],
    ]),
  );
  return world.cities.get("a")!;
}

const dist = (p: Vec2, a: Vec2, b: Vec2) => {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const len2 = vx * vx + vz * vz;
  const t = Math.max(
    0,
    Math.min(1, len2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / len2 : 0),
  );
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vz));
};

describe("scatterProps", () => {
  const meadow = BIOMES.meadow;

  test("is deterministic: same city, same trees", () => {
    const a = scatterProps(layout(), meadow, CLEARANCE);
    const b = scatterProps(layout(), meadow, CLEARANCE);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  test("only places kinds the biome asks for, at plausible sizes", () => {
    for (const p of scatterProps(layout(), meadow, CLEARANCE)) {
      expect(meadow.kinds).toContain(p.kind);
      expect(p.scale).toBeGreaterThanOrEqual(0.72);
      expect(p.scale).toBeLessThanOrEqual(1.28);
      expect(p.yaw).toBeGreaterThanOrEqual(0);
      expect(p.yaw).toBeLessThan(Math.PI * 2);
    }
  });

  test("nothing grows in the sea, on a road, or on a plot", () => {
    const city = layout();
    const props = scatterProps(city, meadow, CLEARANCE);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect(pointInPolygon(p.at, city.outline)).toBe(true);
      for (const node of city.nodes) {
        const at: Vec2 = [node.position[0], node.position[2]];
        expect(Math.hypot(p.at[0] - at[0], p.at[1] - at[1])).toBeGreaterThanOrEqual(
          NODE_STYLE[node.type].scale * 0.75,
        );
      }
      for (const seg of city.roads.segments) {
        for (let i = 1; i < seg.points.length; i++) {
          expect(dist(p.at, seg.points[i - 1]!, seg.points[i]!)).toBeGreaterThanOrEqual(
            CLEARANCE[seg.klass],
          );
        }
      }
      for (const r of city.roads.roundabouts) {
        expect(Math.hypot(p.at[0] - r.center[0], p.at[1] - r.center[1])).toBeGreaterThanOrEqual(
          r.radius,
        );
      }
    }
  });

  test("a biome with nothing to plant plants nothing", () => {
    expect(scatterProps(layout(), { density: 0, kinds: ["tree"] }, CLEARANCE)).toEqual([]);
    expect(scatterProps(layout(), { density: 20, kinds: [] }, CLEARANCE)).toEqual([]);
  });

  test("density drives how much grows", () => {
    const city = layout();
    const sparse = scatterProps(city, { ...meadow, density: 3 }, CLEARANCE);
    const dense = scatterProps(city, { ...meadow, density: 40 }, CLEARANCE);
    expect(dense.length).toBeGreaterThan(sparse.length);
  });
});
