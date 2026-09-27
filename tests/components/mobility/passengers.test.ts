import { expect, test } from "bun:test";
import { createMobilityEngine } from "@/components/mobility/engine";
import {
  advanceMetro,
  createMetroFleet,
  type MetroFleet,
  stationDwellRemaining,
} from "@/components/mobility/metro";
import {
  advancePassengers,
  createPassengerPool,
  MAX_ALIGHT_PER_STOP,
  MIN_TARGET,
  type PassengerPool,
  Phase,
  retargetPassengers,
} from "@/components/mobility/passengers";
import { buildStationAccesses, type StationAccess } from "@/components/mobility/station";
import { circle } from "../../fixtures/trajectory";

interface Rig {
  fleet: MetroFleet;
  pool: PassengerPool;
  accesses: StationAccess[];
  /** One fixed 1/30 s tick of the shared clock, trains then people. */
  run(seconds: number, watch?: () => void): void;
}

function rig(target: number, seed = 7, capacity = 24, radius = 8): Rig {
  const route = circle(radius);
  const fleet = createMetroFleet(route);
  const accesses = buildStationAccesses(route, [0, 0]);
  const pool = createPassengerPool(capacity, seed);
  let watcher: (() => void) | undefined;
  const engine = createMobilityEngine();
  engine.register({
    step: (dt) => {
      advanceMetro(fleet, dt);
      advancePassengers(pool, dt, { accesses, elapsed: fleet.elapsed, target });
      watcher?.();
    },
    render: () => {},
  });
  return {
    fleet,
    pool,
    accesses,
    run(seconds, watch) {
      watcher = watch;
      for (let i = 0; i < Math.round(seconds * 30); i++) {
        engine.advance(1 / 30);
      }
      watcher = undefined;
    },
  };
}

test("nobody boards, or vanishes, unless a rame is standing at their station", () => {
  const r = rig(18);
  let boarded = 0;
  r.run(300, () => {
    for (let i = 0; i < r.pool.count; i++) {
      if (r.pool.phase[i] === Phase.Board) {
        boarded++;
        expect(stationDwellRemaining(r.fleet.elapsed, r.pool.station[i]!)).toBeGreaterThan(0);
      }
    }
  });
  expect(boarded).toBeGreaterThan(0);
});

test("every dwell unloads a group, and every alighter walks out to the street", () => {
  const r = rig(0);
  r.run(90);
  const groups = [0, 0, 0];
  const before = [...r.pool.lastStop];
  let emitted = 0;
  let previous = r.pool.count;
  r.run(270, () => {
    for (let s = 0; s < 3; s++) {
      if (r.pool.lastStop[s] !== before[s]) {
        groups[s]!++;
        before[s] = r.pool.lastStop[s]!;
      }
    }
    // With no arrivals from the street, the pool only ever grows on a dwell.
    emitted += Math.max(0, r.pool.count - previous);
    previous = r.pool.count;
  });
  // 90 s of timetable, two dwells per station, over three periods.
  expect(groups).toEqual([6, 6, 6]);
  expect(emitted).toBeGreaterThanOrEqual(18);
  // Everyone who stepped off has walked away; only the freshest group is left.
  expect(r.pool.count).toBeLessThan(emitted);
  expect(r.pool.count).toBeLessThanOrEqual(2 * MAX_ALIGHT_PER_STOP);
});

test("the pool never overflows and swap-remove leaves no hole", () => {
  const r = rig(60, 3, 12);
  r.run(300, () => {
    expect(r.pool.count).toBeLessThanOrEqual(r.pool.capacity);
    for (let i = 0; i < r.pool.count; i++) {
      expect(r.pool.station[i]!).toBeLessThan(r.accesses.length);
      expect(Number.isFinite(r.pool.x[i]!)).toBe(true);
      expect(Number.isFinite(r.pool.y[i]!)).toBe(true);
      expect(Number.isFinite(r.pool.z[i]!)).toBe(true);
      expect(Number.isFinite(r.pool.yaw[i]!)).toBe(true);
      expect(r.pool.scale[i]!).toBeGreaterThanOrEqual(0);
    }
  });
});

test("a quiet city still shows a populated platform", () => {
  const r = rig(MIN_TARGET);
  let empty = 0;
  r.run(300, () => {
    if (r.pool.count === 0) {
      empty++;
    }
  });
  expect(empty).toBe(0);
});

test("the same seed gives the same crowd", () => {
  const a = rig(18, 42);
  const b = rig(18, 42);
  a.run(20);
  b.run(20);
  expect(b.pool.count).toBe(a.pool.count);
  expect([...b.pool.x]).toEqual([...a.pool.x]);
  expect([...b.pool.y]).toEqual([...a.pool.y]);
  expect([...b.pool.z]).toEqual([...a.pool.z]);
});

test("a rebuilt track keeps the crowd, clamped onto the new access paths", () => {
  const r = rig(18);
  r.run(40);
  const count = r.pool.count;
  expect(count).toBeGreaterThan(0);
  const wider = buildStationAccesses(circle(11), [0, 0]);
  retargetPassengers(r.pool, wider);
  expect(r.pool.count).toBe(count);
  for (let i = 0; i < r.pool.count; i++) {
    expect(r.pool.dist[i]!).toBeGreaterThanOrEqual(0);
    expect(r.pool.dist[i]!).toBeLessThanOrEqual(wider[r.pool.station[i]!]!.walk.total);
  }
});
