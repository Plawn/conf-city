import { expect, test } from "bun:test";
import { trafficBudgets } from "@/components/traffic/budget";
import { writeDemand } from "@/components/traffic/demand";
import { trafficStats } from "@/components/traffic/lifecycle";
import { reconfigureSim } from "@/components/traffic/reconfigure";
import { advance, createSim, type TrafficRoute } from "@/components/traffic/sim";
import { mulberry32 } from "@/layout/random";

const routes: TrafficRoute[] = [
  {
    key: "ring",
    zone: "city:a",
    cityId: "a",
    sourceAddr: "a/api",
    points: [
      [0, 0, 0],
      [8, 0, 0],
      [8, 0, 8],
      [0, 0, 8],
      [0, 0, 0],
    ],
    loop: true,
    rateScale: 1,
  },
];
function run(sim: ReturnType<typeof createSim>, seconds: number) {
  for (let i = 0; i < seconds * 30; i++) {
    advance(sim, 1 / 30);
  }
}

test("duplicate routes do not add lane capacity, widening and separate levels do", () => {
  const road: TrafficRoute = {
    ...routes[0]!,
    points: [
      [0, 0, 0],
      [20, 0, 0],
    ],
    lanes: [[0.3, 0.3]],
  };
  const budget = trafficBudgets([road], 100).total;
  expect(trafficBudgets([road, { ...road, key: "duplicate" }], 100).total).toBe(budget);
  expect(trafficBudgets([{ ...road, lanes: [[0.3, 0.75]] }], 100).total).toBeGreaterThan(budget);
  expect(
    trafficBudgets(
      [
        road,
        {
          ...road,
          points: [
            [0, 2, 0],
            [20, 2, 0],
          ],
        },
      ],
      100,
    ).total,
  ).toBeGreaterThan(budget);
});

test("saturated loops stay bounded and all vehicles retire when arrivals stop", () => {
  const sim = createSim(routes, 20, 4, mulberry32(42));
  sim.rate.fill(8);
  run(sim, 300);
  expect(trafficStats(sim).active).toBeLessThanOrEqual(sim.budgets.total);
  expect(trafficStats(sim).oldest).toBeLessThan(122);
  expect(sim.totals.completed + sim.totals.retired).toBeGreaterThan(10);
  expect(sim.totals.rejected).toBeGreaterThan(0);
  sim.rate.fill(0);
  run(sim, 125);
  expect(trafficStats(sim).active).toBe(0);
});

test("a stalled vehicle retires even when its following speed is zero", () => {
  const sim = createSim(routes, 20, 0, mulberry32(4));
  sim.rate.fill(4);
  run(sim, 3);
  sim.rate.fill(0);
  expect(sim.cars.count).toBeGreaterThan(0);
  sim.cars.speed.fill(0);
  sim.cars.vel.fill(0);
  run(sim, 45);
  expect(sim.cars.count).toBe(0);
  expect(sim.totals.retired).toBeGreaterThan(0);
});

test("route reordering and widening preserve live vehicle identity and age", () => {
  const sim = createSim(routes, 20, 4, mulberry32(3));
  sim.rate.fill(2);
  run(sim, 5);
  const upgraded = [
    { ...routes[0]!, key: "extra" },
    { ...routes[0]!, lanes: routes[0]!.points.slice(1).map(() => [0.3, 0.7] as [number, number]) },
  ];
  const next = reconfigureSim(sim, routes, upgraded, 20, 4);
  expect(next.cars.count).toBe(sim.cars.count);
  expect([...next.cars.id.slice(0, next.cars.count)]).toEqual([
    ...sim.cars.id.slice(0, sim.cars.count),
  ]);
  expect([...next.cars.age.slice(0, next.cars.count)]).toEqual([
    ...sim.cars.age.slice(0, sim.cars.count),
  ]);
  expect([...next.cars.route.slice(0, next.cars.count)].every((r) => r === 1)).toBe(true);
});

test("metro shifts 45% of demand; stale, down and hidden services stop spawning", () => {
  const sim = createSim(routes, 20, 4);
  const telemetry = new Map([
    ["a/api", { liveness: "healthy" as const, metrics: { netTxKbps: 2000 }, lastSeen: 1000 }],
  ]);
  writeDemand(sim, routes, telemetry, { cities: {}, bridges: {} }, new Set(["a"]), 1000);
  const base = sim.rate[0]!;
  writeDemand(sim, routes, telemetry, { cities: { a: 2 }, bridges: {} }, new Set(["a"]), 1000);
  expect(sim.rate[0]!).toBeCloseTo(base * 0.55);
  writeDemand(sim, routes, telemetry, { cities: {}, bridges: {} }, new Set(["a"]), 32000);
  expect(sim.rate[0]).toBe(0);
  writeDemand(sim, routes, telemetry, { cities: {}, bridges: {} }, new Set(), 1000);
  expect(sim.rate[0]).toBe(0);
  expect(sim.enabled[0]).toBe(0);
});

test("vehicles on separate bridge levels do not brake for the floor below", () => {
  const points: [number, number, number][] = [
    [0, 0, 0],
    [30, 0, 0],
  ];
  const elevated: TrafficRoute[] = [
    { points, rateScale: 1 },
    { points: points.map(([x, , z]) => [x, 3, z]), rateScale: 1 },
  ];
  const sim = createSim(elevated, 40, 0, mulberry32(7));
  sim.rate.fill(0.5);
  run(sim, 30);
  let upper = 0;
  for (let i = 0; i < sim.cars.count; i++) {
    if (sim.cars.route[i] === 1) {
      upper++;
      expect(sim.cars.y[i]!).toBeCloseTo(3.06);
      expect(sim.cars.vel[i]!).toBeGreaterThan(0.5);
    }
  }
  expect(upper).toBeGreaterThan(0);
  sim.rate.fill(0);
  run(sim, 30);
  expect(sim.cars.count).toBe(0);
});
