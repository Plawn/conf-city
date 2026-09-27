import { describe, expect, test } from "bun:test";
import { makeDriver } from "@/components/geo/drivable";
import {
  advance,
  createSim,
  MIN_GAP,
  type Pool,
  type Sim,
  type TrafficRoute,
} from "@/components/traffic/sim";
import { TERRAIN } from "@/domain/nodeStyle";
import type { RoadNetwork, Vec2 } from "@/layout/types";

/** Deterministic random so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const Y = TERRAIN.roadY;

function flat(points: Vec2[]): [number, number, number][] {
  return points.map(([x, z]) => [x, Y, z]);
}

function pools(sim: Sim): Pool[] {
  return [sim.cars, sim.trucks];
}

function runAt(sim: Sim, seconds: number, dt: number, each?: (sim: Sim) => void): void {
  for (let t = 0; t < seconds; t += dt) {
    advance(sim, dt);
    each?.(sim);
  }
}

interface Pair {
  distance: number;
  h: number;
  a: { pool: Pool; i: number };
  b: { pool: Pool; i: number };
}

/** Every pair of live vehicles neither of which is in its stall-release window. */
function pairs(sim: Sim): Pair[] {
  const all: { pool: Pool; i: number }[] = [];
  for (const pool of pools(sim)) {
    for (let i = 0; i < pool.count; i++) {
      if (pool.free[i]! <= 0) {
        all.push({ pool, i });
      }
    }
  }
  const out: Pair[] = [];
  for (let p = 0; p < all.length; p++) {
    for (let q = p + 1; q < all.length; q++) {
      const a = all[p]!;
      const b = all[q]!;
      const distance = Math.hypot(a.pool.x[a.i]! - b.pool.x[b.i]!, a.pool.z[a.i]! - b.pool.z[b.i]!);
      const h = a.pool.hx[a.i]! * b.pool.hx[b.i]! + a.pool.hz[a.i]! * b.pool.hz[b.i]!;
      out.push({ distance, h, a, b });
    }
  }
  return out;
}

function count(sim: Sim): number {
  return sim.cars.count + sim.trucks.count;
}

function setRates(sim: Sim, rate: number): void {
  sim.rate.fill(rate);
}

describe.each([30, 60])("traffic sim at %i Hz", (hz) => {
  const run = (sim: Sim, seconds: number, each?: (sim: Sim) => void) =>
    runAt(sim, seconds, 1 / hz, each);
  test("vehicles heading the same way never overlap, even on a shared trunk", () => {
    const routes: TrafficRoute[] = [
      {
        points: flat([
          [0, 0],
          [10, 0],
          [20, 0],
        ]),
        rateScale: 1,
      },
      {
        points: flat([
          [10, -10],
          [10, 0],
          [20, 0],
        ]),
        rateScale: 1,
      },
    ];
    const sim = createSim(routes, 160, 40, lcg(7));
    setRates(sim, 3);
    let closest = Infinity;
    let peak = 0;
    run(sim, 60, (s) => {
      peak = Math.max(peak, count(s));
      for (const p of pairs(s)) {
        if (p.h > 0.5) {
          closest = Math.min(closest, p.distance);
        }
      }
    });
    expect(peak).toBeGreaterThan(8); // the trunk is busy, this is not a trivial pass
    expect(closest).toBeGreaterThanOrEqual(MIN_GAP * 0.9);
  });

  test("spawning never stacks vehicles on the same route", () => {
    const sim = createSim(
      [
        {
          points: flat([
            [0, 0],
            [30, 0],
          ]),
          rateScale: 1,
        },
      ],
      160,
      40,
      lcg(3),
    );
    setRates(sim, 50);
    let closest = Infinity;
    run(sim, 10, (s) => {
      for (const p of pairs(s)) {
        closest = Math.min(closest, p.distance);
      }
    });
    expect(closest).toBeGreaterThanOrEqual(MIN_GAP * 0.9);
    // Admission stops at the physical lane budget even under excessive demand.
    expect(count(sim)).toBeLessThanOrEqual(sim.budgets.total);
    expect(count(sim)).toBeGreaterThan(sim.budgets.total / 2);
  });

  test("two perpendicular streams without a roundabout both drain", () => {
    const routes: TrafficRoute[] = [
      {
        points: flat([
          [0, 0],
          [20, 0],
        ]),
        rateScale: 1,
      },
      {
        points: flat([
          [10, -10],
          [10, 10],
        ]),
        rateScale: 1,
      },
    ];
    const sim = createSim(routes, 160, 40, lcg(11));
    setRates(sim, 1.5);
    run(sim, 30);
    expect(count(sim)).toBeGreaterThan(0);
    setRates(sim, 0);
    run(sim, 30);
    expect(count(sim)).toBe(0);
  });

  test("a vehicle circulating on a roundabout is never caught by one entering", () => {
    const r = { center: [6, 0] as Vec2, radius: 1.2, klass: "avenue" as const };
    const ew: Vec2[] = [
      [0, 0],
      [6, 0],
      [12, 0],
    ];
    const ns: Vec2[] = [
      [6, -8],
      [6, 0],
      [6, 8],
    ];
    const net: RoadNetwork = {
      segments: [
        { points: [ew[0]!, ew[1]!], klass: "street" },
        { points: [ew[1]!, ew[2]!], klass: "street" },
        { points: [ns[0]!, ns[1]!], klass: "street" },
        { points: [ns[1]!, ns[2]!], klass: "street" },
      ],
      roundabouts: [r],
      driveways: [],
      ring: [],
      routes: new Map(),
    };
    const driver = makeDriver([net]);
    const routes: TrafficRoute[] = [ew, ns, [...ns].reverse(), [...ew].reverse()].map((pts) => {
      const path = driver.street(pts);
      return { ...path, rateScale: 1 };
    });
    for (const route of routes) {
      expect(route.ring!.some(Boolean)).toBe(true);
    }
    const sim = createSim(routes, 160, 40, lcg(5));
    setRates(sim, 1.2);
    let closest = Infinity;
    let circulated = 0;
    run(sim, 90, (s) => {
      const onRing = (p: { pool: Pool; i: number }) =>
        s.geoms[p.pool.route[p.i]!]!.lanes[p.pool.lane[p.i]!]!.ring[p.pool.seg[p.i]!] === 1;
      for (const pool of pools(s)) {
        for (let i = 0; i < pool.count; i++) {
          if (onRing({ pool, i })) {
            circulated++;
          }
        }
      }
      for (const p of pairs(s)) {
        if (onRing(p.a) !== onRing(p.b)) {
          closest = Math.min(closest, p.distance);
        }
      }
    });
    expect(circulated).toBeGreaterThan(100);
    // Bumper to bumper is 0.55: anything under that is two models through each other.
    expect(closest).toBeGreaterThanOrEqual(0.55);
  });
});
