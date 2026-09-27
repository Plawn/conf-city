import { expect, test } from "bun:test";
import { createPose, samplePose, sampleTrajectory } from "@/sim/mobility/trajectory";
import { place, type TrafficRoute } from "@/sim/traffic/pool";
import { reconfigureSim } from "@/sim/traffic/reconfigure";
import { buildRouteGeom, RIDE_HEIGHT } from "@/sim/traffic/routeGeometry";
import { advance, createSim } from "@/sim/traffic/sim";

test("lane paths stay continuous through sharp turns, width transitions and loop closure", () => {
  const g = buildRouteGeom(
    [
      [0, 0, 0],
      [5, 0, 0],
      [5, 1, 5],
      [0, 0, 5],
      [0, 0, 0],
    ],
    [
      [0.25, 0.7],
      [0.4, 0.8],
      [0.25, 0.25],
      [0.3, 0.6],
    ],
    [false, true, false, false],
    true,
  )!;
  for (const lane of g.lanes) {
    for (const distance of lane.cum) {
      const a = samplePose(lane, distance - 1e-6, 0.55, createPose(), createPose());
      const b = samplePose(lane, distance + 1e-6, 0.55, createPose(), createPose());
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(3e-6);
      expect(a.fx * b.fx + a.fy * b.fy + a.fz * b.fz).toBeGreaterThan(0.99999);
    }
  }
});

test("a width blend finishes across short segments instead of resetting at each vertex", () => {
  const g = buildRouteGeom(
    [
      [0, 0, 0],
      [1, 0, 0],
      [1.1, 0, 0],
      [1.2, 0, 0],
      [1.3, 0, 0],
      [1.4, 0, 0],
      [1.8, 0, 0],
      [12, 0, 0],
    ],
    [[0.25, 0.25], ...Array.from({ length: 6 }, (): [number, number] => [0.6, 0.6])],
  )!;
  // The blend is rate-limited (`LANE_SLEW`), so it takes several units of road
  // rather than one vertex — but it does finish, and only once.
  expect(g.pz[g.pz.length - 1]).toBeCloseTo(0.6, 8);
  for (let i = 1; i < g.pz.length; i++) {
    expect(g.pz[i]! + 1e-9).toBeGreaterThanOrEqual(g.pz[i - 1]!);
  }
});

test("simulation position and anticipation sample the exact same lane path", () => {
  const route: TrafficRoute = {
    points: [
      [0, 0, 0],
      [4, 0, 0],
      [4, 1, 4],
    ],
    lanes: [
      [0.25, 0.7],
      [0.4, 0.8],
    ],
    rateScale: 1,
  };
  const sim = createSim([route], 1, 0);
  sim.cars.count = 1;
  sim.cars.id[0] = 1;
  sim.cars.lane[0] = 1;
  sim.cars.dist[0] = 3.9;
  const g = sim.geoms[0]!.lanes[1];
  place(sim.cars, 0, g);
  advance(sim, 1 / 30);
  const current = sampleTrajectory(g, sim.cars.dist[0]!, createPose());
  expect(sim.cars.x[0]).toBeCloseTo(current.x, 5);
  expect(sim.cars.y[0]).toBeCloseTo(current.y + RIDE_HEIGHT, 5);
  for (let k = 0; k < 4; k++) {
    const expected = sampleTrajectory(g, sim.cars.dist[0]! + k * 0.4, createPose());
    expect(sim.ppx[k]).toBeCloseTo(expected.x, 5);
    expect(sim.ppy[k]).toBeCloseTo(expected.y + RIDE_HEIGHT, 5);
    expect(sim.ppz[k]).toBeCloseTo(expected.z, 5);
  }
});

test("a lane-only upgrade immediately reprojects the retained vehicle and preserves its lifetime", () => {
  const route: TrafficRoute = {
    key: "r",
    points: [
      [0, 0, 0],
      [10, 0, 0],
    ],
    lanes: [[0.25, 0.25]],
    rateScale: 1,
  };
  const sim = createSim([route], 1, 0);
  sim.cars.count = 1;
  sim.cars.id[0] = 42;
  sim.cars.age[0] = 12;
  sim.cars.dist[0] = 5;
  sim.cars.lane[0] = 1;
  place(sim.cars, 0, sim.geoms[0]!.lanes[1]);
  const upgraded = { ...route, lanes: [[0.4, 0.8]] as [number, number][] };
  const next = reconfigureSim(sim, [route], [upgraded], 1, 0);
  expect(next.cars.id[0]).toBe(42);
  expect(next.cars.age[0]).toBe(12);
  expect(next.cars.dist[0]).toBeCloseTo(5, 5);
  expect(next.cars.z[0]).toBeCloseTo(0.8, 5);
  expect(next.cars.qw[0]).toBeCloseTo(Math.SQRT1_2, 5);
});

test("deduplication preserves the lanes and roundabout tag of retained segments", () => {
  const g = buildRouteGeom(
    [
      [0, 0, 0],
      [0, 0, 0],
      [2, 0, 0],
    ],
    [
      [9, 9],
      [0.3, 0.5],
    ],
    [false, true],
  )!;
  expect([...g.lanes[0].pz].every((z) => Math.abs(z - 0.3) < 1e-8)).toBe(true);
  expect([...g.lanes[1].pz].every((z) => Math.abs(z - 0.5) < 1e-8)).toBe(true);
  expect([...g.ring].every((r) => r === 1)).toBe(true);
});
