import { describe, expect, test } from "bun:test";
import type { ResolvedNode } from "@/domain/types";
import { CLASS_STYLE, PAVEMENT } from "@/geo/roadStyle";
import { footprintRadius, PITCH } from "@/layout/constants";
import { distToPolyline, vecKey } from "@/layout/geometry";
import { layoutCity } from "@/layout/layoutCity";
import { layoutWorld } from "@/layout/layoutWorld";
import { drawnOffset, plotFootprint, settlePlots } from "@/layout/plotSettle";
import { buildRoadNetwork } from "@/layout/roads/network";
import { grid, intraLinks } from "../fixtures/layout";

const PAIRS: [string, string][] = [
  ["n00", "n22"],
  ["n01", "n21"],
  ["n10", "n12"],
  ["n02", "n20"],
];

function settled(nodes: ResolvedNode[] = grid("a", 3, 3)) {
  const links = intraLinks("a", PAIRS);
  const layout = layoutCity("a", nodes, [], links);
  const routed = buildRoadNetwork(layout, links);
  return { routed, ...settlePlots("a", layout.nodes, routed) };
}

describe("settlePlots", () => {
  test("is deterministic", () => {
    expect(settled().nodes.map((n) => n.plot)).toEqual(settled().nodes.map((n) => n.plot));
  });

  test("keeps every footprint off the kerbs and inside its plot", () => {
    const { nodes, roads } = settled();
    for (const n of nodes) {
      const [ox, oz] = n.plot!.offset;
      expect(Math.hypot(ox, oz)).toBeLessThan(PITCH / 2);
      const centre: [number, number] = [n.position[0], n.position[2]];
      const p: [number, number] = [centre[0] + ox, centre[1] + oz];
      for (const s of roads.segments) {
        const edge = CLASS_STYLE[s.klass].width / 2 + PAVEMENT;
        const before = distToPolyline(centre, s.points) - edge;
        const after = distToPolyline(p, s.points) - edge;
        expect(after).toBeGreaterThanOrEqual(Math.min(before, footprintRadius(n.type)) - 1e-9);
      }
    }
  });

  test("turns each building to the street it opens onto", () => {
    const { nodes, roads } = settled();
    for (const n of nodes) {
      const centre: [number, number] = [n.position[0], n.position[2]];
      const own = roads.driveways.filter(
        (d) => Math.hypot(d.mouth[0] - centre[0], d.mouth[1] - centre[1]) <= PITCH / 2 + 1e-9,
      );
      if (own.length === 0) {
        continue;
      }
      // The model's front (−Z) turned by `yaw` points within the tilt of some mouth.
      const yaw = n.plot!.yaw;
      const front: [number, number] = [-Math.sin(yaw), -Math.cos(yaw)];
      const best = Math.max(
        ...own.map((d) => {
          const dx = d.mouth[0] - centre[0];
          const dz = d.mouth[1] - centre[1];
          return (front[0] * dx + front[1] * dz) / Math.hypot(dx, dz);
        }),
      );
      expect(best).toBeGreaterThan(Math.cos(0.15));
    }
  });

  test("moves the doors with their building, never a mouth or a route", () => {
    const { routed: before, roads: after, nodes } = settled();
    expect(after.driveways.map((d) => vecKey(d.mouth))).toEqual(
      before.driveways.map((d) => vecKey(d.mouth)),
    );
    expect(after.routes).toBe(before.routes);
    expect(after.segments).toBe(before.segments);
    for (const [i, d] of after.driveways.entries()) {
      const owner = nodes.find(
        (n) =>
          Math.hypot(
            before.driveways[i]!.door[0] - n.position[0],
            before.driveways[i]!.door[1] - n.position[2],
          ) <
          PITCH / 2,
      )!;
      expect(d.door[0] - before.driveways[i]!.door[0]).toBeCloseTo(owner.plot!.offset[0], 9);
      expect(d.door[1] - before.driveways[i]!.door[1]).toBeCloseTo(owner.plot!.offset[1], 9);
    }
  });

  test("layoutWorld settles buildings and leaves ports alone", () => {
    const world = layoutWorld(["a"], grid("a", 3, 3), intraLinks("a", PAIRS));
    expect(world.nodes.every((n) => n.isPort || n.plot !== undefined)).toBe(true);
    expect(new Set(world.nodes.map((n) => n.plot?.yaw.toFixed(2))).size).toBeGreaterThan(3);
  });
});

describe("districts", () => {
  /** Five `core` services, the rest ungrouped. */
  const grouped = () => grid("a", 3, 3).map((n, i) => (i < 5 ? { ...n, group: "core" } : n));

  test("a district huddles towards its centre and rises into a skyline", () => {
    const { nodes } = settled(grouped());
    const members = nodes.filter((n) => n.group === "core");
    const cx = members.reduce((a, n) => a + n.position[0], 0) / members.length;
    const cz = members.reduce((a, n) => a + n.position[2], 0) / members.length;
    for (const n of members) {
      expect(n.plot!.district).toBe("core");
      expect(n.plot!.rise!).toBeGreaterThan(1);
      const [ox, oz] = n.plot!.offset;
      // Never pushed away from the core.
      expect(ox * (cx - n.position[0]) + oz * (cz - n.position[2])).toBeGreaterThanOrEqual(-1e-9);
    }
    const byDistance = [...members].sort(
      (a, b) =>
        Math.hypot(a.position[0] - cx, a.position[2] - cz) -
        Math.hypot(b.position[0] - cx, b.position[2] - cz),
    );
    expect(byDistance[0]!.plot!.rise!).toBeGreaterThan(byDistance.at(-1)!.plot!.rise!);
    for (const n of nodes.filter((n) => n.group !== "core")) {
      expect(n.plot!.district).toBeUndefined();
      expect(n.plot!.rise).toBeUndefined();
    }
  });

  test("two services are a pair, not a district", () => {
    const nodes = grid("a", 3, 3).map((n, i) => (i < 2 ? { ...n, group: "duo" } : n));
    expect(settled(nodes).nodes.every((n) => n.plot!.district === undefined)).toBe(true);
  });
});

describe("drawnOffset", () => {
  test("hands the shift back as the footprint outgrows the settle", () => {
    const plot = { offset: [0.6, 0.8] as [number, number], yaw: 0 };
    expect(drawnOffset(plot, 1, 1)).toEqual([0.6, 0.8]);
    const half = drawnOffset(plot, 1, 1.5);
    expect(Math.hypot(half[0], half[1])).toBeCloseTo(0.5, 9);
    expect(drawnOffset(plot, 1, 3)).toEqual([0, 0]);
  });
});

describe("lots", () => {
  /** A 4×4 city, every third service a database, `n00` linked to all. */
  function hub() {
    const nodes = grid("a", 4, 4).map((n, i) => (i % 3 === 0 ? { ...n, type: "db" as const } : n));
    const ids = nodes.map((n) => n.id);
    const pairs: [string, string][] = ids.slice(1).map((id) => [ids[0]!, id]);
    pairs.push(...ids.slice(2).map((id, k): [string, string] => [ids[k]!, id]));
    return layoutWorld(["a"], nodes, intraLinks("a", pairs));
  }

  test("a well-connected service spreads over a lot of free cells", () => {
    const world = hub();
    const lots = world.nodes.filter((n) => n.plot?.lot);
    expect(lots.length).toBeGreaterThan(0);
    for (const n of lots) {
      for (const [cx, cz] of n.plot!.lot!.cells.slice(1)) {
        const at: [number, number] = [n.position[0] + cx, n.position[2] + cz];
        // Never another building's own cell.
        for (const m of world.nodes) {
          expect(Math.hypot(m.position[0] - at[0], m.position[2] - at[1])).toBeGreaterThan(1);
        }
      }
    }
  });

  test("no two footprints overlap and no lot stands on asphalt", () => {
    const world = hub();
    const buildings = world.nodes.filter((n) => !n.isPort);
    const prints = buildings.map((n) => plotFootprint(n, footprintRadius(n.type) * 0.75));
    for (let i = 0; i < prints.length; i++) {
      for (let j = i + 1; j < prints.length; j++) {
        for (const a of prints[i]!) {
          for (const b of prints[j]!) {
            expect(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1])).toBeGreaterThan(a.r + b.r);
          }
        }
      }
    }
    const segments = world.cities.get("a")!.roads.segments;
    for (const n of buildings.filter((n) => n.plot?.lot)) {
      const { offset, yaw, lot } = n.plot!;
      const r = footprintRadius(n.type);
      const hx = r * lot!.stretch[0];
      const hz = r * lot!.stretch[1];
      for (const [u, v] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        // The model frame turned by `yaw` about y (three.js convention).
        const x = u * hx;
        const z = v * hz;
        const p: [number, number] = [
          n.position[0] + offset[0] + x * Math.cos(yaw) + z * Math.sin(yaw),
          n.position[2] + offset[1] - x * Math.sin(yaw) + z * Math.cos(yaw),
        ];
        for (const s of segments) {
          expect(distToPolyline(p, s.points)).toBeGreaterThan(CLASS_STYLE[s.klass].width / 2);
        }
      }
    }
  });
});
