import { describe, expect, test } from "bun:test";
import { TERRAIN } from "../../domain/nodeStyle";
import type { RoadClass, RoadNetwork, Vec2 } from "../../layout/types";
import { buildRouteGeom } from "../traffic/routeGeometry";
import { laneOffsets, makeDriver } from "./drivable";
import { ringRadii } from "./roadStyle";
import { drivingRadius } from "./roundabouts";

function network(partial: Partial<RoadNetwork>): RoadNetwork {
  return { segments: [], roundabouts: [], driveways: [], ring: [], routes: new Map(), ...partial };
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("makeDriver", () => {
  test("a street corner is rounded and every step gets the street's lane", () => {
    const pts: Vec2[] = [
      [0, 0],
      [6, 0],
      [6, 6],
    ];
    const driver = makeDriver([network({ segments: [{ points: pts, klass: "street" }] })]);
    const path = driver.street(pts);
    expect(path.points.length).toBeGreaterThan(3);
    expect(path.lanes.length).toBe(path.points.length - 1);
    expect(path.points[0]).toEqual([0, TERRAIN.roadY, 0]);
    expect(path.points[path.points.length - 1]).toEqual([6, TERRAIN.roadY, 6]);
    for (const lane of path.lanes) {
      expect(lane).toEqual(laneOffsets("street"));
    }
    // The corner itself is gone: no point sits on (6, 0).
    expect(path.points.some(([x, , z]) => near(x, 6) && near(z, 0))).toBe(false);
  });

  test("a boulevard offers two lanes, a street one", () => {
    expect(laneOffsets("street")[0]).toBe(laneOffsets("street")[1]);
    const [a, b] = laneOffsets("boulevard");
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(TERRAIN.roadWidthBoulevard / 2);
  });

  test("roundabout arcs keep their radius and take the roundabout's lanes", () => {
    const r = { center: [6, 0] as Vec2, radius: 1.2, klass: "avenue" as const };
    const net = network({
      segments: [
        {
          points: [
            [0, 0],
            [6, 0],
          ],
          klass: "street",
        },
        {
          points: [
            [6, 0],
            [12, 0],
          ],
          klass: "street",
        },
      ],
      roundabouts: [r],
    });
    const path = makeDriver([net]).street([
      [0, 0],
      [6, 0],
      [12, 0],
    ]);
    const onArc = path.points.filter(([x, , z]) =>
      near(Math.hypot(x - 6, z), drivingRadius(r), 1e-4),
    );
    expect(onArc.length).toBeGreaterThanOrEqual(3);
    // A lane on the arc is the avenue's; on the approach, the street's.
    expect(path.lanes[0]).toEqual(laneOffsets("street"));
    const arcLane = path.lanes[Math.floor(path.lanes.length / 2)]!;
    expect(arcLane).toEqual(laneOffsets("avenue"));
  });

  test("a roundabout is entered and left by tangent blends, never a sharp corner", () => {
    const r = { center: [6, 0] as Vec2, radius: 1.2, klass: "avenue" as const };
    const net = network({
      segments: [
        {
          points: [
            [0, 0],
            [6, 0],
          ],
          klass: "street",
        },
        {
          points: [
            [6, 0],
            [12, 0],
          ],
          klass: "street",
        },
      ],
      roundabouts: [r],
    });
    const path = makeDriver([net]).street([
      [0, 0],
      [6, 0],
      [12, 0],
    ]);
    const { inner } = ringRadii(r);
    let maxTurn = 0;
    for (let i = 1; i < path.points.length - 1; i++) {
      const [ax, , az] = path.points[i - 1]!;
      const [bx, , bz] = path.points[i]!;
      const [cx, , cz] = path.points[i + 1]!;
      const a1 = Math.atan2(bz - az, bx - ax);
      const a2 = Math.atan2(cz - bz, cx - bx);
      let turn = Math.abs(a2 - a1);
      if (turn > Math.PI) {
        turn = 2 * Math.PI - turn;
      }
      maxTurn = Math.max(maxTurn, turn);
    }
    // The radial → tangent corner used to be 90°.
    expect(maxTurn).toBeLessThanOrEqual(Math.PI / 6 + 1e-6);
    for (const [x, , z] of path.points) {
      expect(Math.hypot(x - 6, z)).toBeGreaterThanOrEqual(inner - 1e-6);
    }
    expect(path.ring.length).toBe(path.points.length - 1);
    const arcSteps = path.ring.filter(Boolean).length;
    expect(arcSteps).toBeGreaterThanOrEqual(2);
    // The first and last steps are on the approaches, off the ring.
    expect(path.ring[0]).toBe(false);
    expect(path.ring[path.ring.length - 1]).toBe(false);
  });

  test("a leg too short for a blend keeps its endpoint exactly", () => {
    const r = { center: [6, 0] as Vec2, radius: 1.2, klass: "avenue" as const };
    const { outer } = ringRadii(r);
    const end: Vec2 = [6 + outer, 0];
    const net = network({
      segments: [
        {
          points: [
            [0, 0],
            [6, 0],
          ],
          klass: "street",
        },
        { points: [[6, 0], end], klass: "street" },
      ],
      roundabouts: [r],
    });
    const path = makeDriver([net]).street([[0, 0], [6, 0], end]);
    const last = path.points[path.points.length - 1]!;
    expect(last[0]).toBe(end[0]);
    expect(last[2]).toBe(end[1]);
    expect(path.points[0]![0]).toBe(0);
    expect(path.ring.length).toBe(path.points.length - 1);
  });

  test("a ring loop closes on a vertex clear of the roundabouts, both ways round", () => {
    const ring: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const net = network({
      segments: [{ points: [...ring, ring[0]!], klass: "avenue", ring: true }],
      roundabouts: [{ center: [0, 0], radius: 1.2, klass: "avenue" }],
      ring,
    });
    const driver = makeDriver([net]);
    for (const reverse of [false, true]) {
      const loop = driver.loop(ring, reverse)!;
      expect(loop).not.toBeNull();
      const first = loop.points[0]!;
      const last = loop.points[loop.points.length - 1]!;
      expect(first).toEqual(last);
      // The seam is a mid-edge point well clear of the roundabout's tarmac...
      expect(Math.hypot(first[0], first[2])).toBeGreaterThan(2.5);
      // ...and the loop closes smoothly there: no sharp flick every lap.
      const after = loop.points[1]!;
      const before = loop.points[loop.points.length - 2]!;
      const a = Math.atan2(after[2] - first[2], after[0] - first[0]);
      const b = Math.atan2(last[2] - before[2], last[0] - before[0]);
      expect(Math.abs(((a - b + Math.PI) % (2 * Math.PI)) - Math.PI)).toBeLessThan(0.12);
      expect(loop.lanes.length).toBe(loop.points.length - 1);
    }
    expect(
      driver.loop(
        [
          [0, 0],
          [1, 0],
        ],
        false,
      ),
    ).toBeNull();
  });

  test("a crossing arches over the deck with the avenue's lanes", () => {
    const net = network({
      segments: [
        {
          points: [
            [0, 0],
            [6, 0],
          ],
          klass: "street",
        },
      ],
    });
    const path = makeDriver([net]).crossing(
      [
        [0, 0],
        [6, 0],
        [20, 0],
        [26, 0],
      ],
      [
        [6, 0],
        [20, 0],
      ],
    );
    expect(path.lanes.length).toBe(path.points.length - 1);
    const top = Math.max(...path.points.map((p) => p[1]));
    expect(top).toBeGreaterThan(TERRAIN.roadY + TERRAIN.bridgeMaxRise * 0.9);
    const deckLanes = path.lanes.filter((l) => l[0] === laneOffsets("avenue")[0]);
    expect(deckLanes.length).toBeGreaterThanOrEqual(12);
    expect(path.lanes[0]).toEqual(laneOffsets("street"));
  });
});

describe("driven lanes", () => {
  /** A crossroads with a roundabout, in one class, and the four routes through it. */
  function crossroads(klass: RoadClass) {
    const ew: Vec2[] = [
      [-8, 0],
      [0, 0],
      [8, 0],
    ];
    const ns: Vec2[] = [
      [0, -8],
      [0, 0],
      [0, 8],
    ];
    const net = network({
      segments: [ew, ns].flatMap((path) =>
        path.slice(1).map((p, i) => ({ points: [path[i]!, p], klass })),
      ),
      roundabouts: [{ center: [0, 0], radius: 1.2, klass }],
    });
    const driver = makeDriver([net]);
    return [ew, ns, [...ew].reverse(), [...ns].reverse()].map((points) => driver.street(points));
  }

  /**
   * The path a vehicle in `lane` actually drives, offset to the driver's right
   * — the same `(-dz, dx)` side `traffic/sim.ts` uses.
   */
  function drivenLane(path: ReturnType<ReturnType<typeof makeDriver>["street"]>, lane: number) {
    return buildRouteGeom(path.points, path.lanes, path.ring, false)!.lanes[lane === 1 ? 1 : 0];
  }

  for (const klass of ["street", "avenue", "boulevard"] as const) {
    for (const lane of [0, 1]) {
      test(`a ${klass} roundabout: lane ${lane} never folds back or kinks`, () => {
        for (const path of crossroads(klass)) {
          const g = drivenLane(path, lane);
          for (let s = 0; s + 1 < g.dirX.length; s++) {
            const dot =
              g.dirX[s]! * g.dirX[s + 1]! +
              g.dirY[s]! * g.dirY[s + 1]! +
              g.dirZ[s]! * g.dirZ[s + 1]!;
            // A reversal — the fold that made a vehicle appear to drive backwards.
            expect(dot).toBeGreaterThan(0);
            expect((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI).toBeLessThan(6);
          }
        }
      });
    }
  }

  test("a leg too short for the full blend still joins the ring tangentially", () => {
    const klass = "street" as const;
    const roundabout = { center: [0, 0] as Vec2, radius: 1.2, klass };
    // 1.9 from the centre: too short for the full `entryRadius`, so the blend
    // shrinks — where it used to give up and join the ring radially.
    const leg: Vec2[] = [
      [-8, 0],
      [0, 0],
      [1.9, 0],
    ];
    const net = network({
      segments: leg.slice(1).map((p, i) => ({ points: [leg[i]!, p], klass })),
      roundabouts: [roundabout],
    });
    const path = makeDriver([net]).street(leg);
    // Where the path last leaves the driving circle. A radial join sets off
    // straight outwards from there — a 90° corner against the ring, and the
    // "sliding into the roundabout" look. A tangent join leaves along the ring.
    const R = drivingRadius(roundabout);
    let exit = -1;
    for (let i = path.points.length - 1; i > 0; i--) {
      const [x, , z] = path.points[i - 1]!;
      if (Math.abs(Math.hypot(x, z) - R) < 1e-6) {
        exit = i;
        break;
      }
    }
    expect(exit).toBeGreaterThan(0);
    const a = path.points[exit - 1]!;
    const b = path.points[exit]!;
    const radial =
      ((b[0] - a[0]) * a[0] + (b[2] - a[2]) * a[2]) /
      (Math.hypot(b[0] - a[0], b[2] - a[2]) * Math.hypot(a[0], a[2]));
    expect(Math.abs(radial)).toBeLessThan(0.35);
    // And nothing anywhere on the path turns sharply.
    for (let i = 1; i + 1 < path.points.length; i++) {
      const p = path.points[i - 1]!;
      const q = path.points[i]!;
      const r = path.points[i + 1]!;
      const t = Math.atan2(r[2] - q[2], r[0] - q[0]) - Math.atan2(q[2] - p[2], q[0] - p[0]);
      const turn = Math.abs(((t + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect((turn * 180) / Math.PI).toBeLessThan(6);
    }
  });
});
