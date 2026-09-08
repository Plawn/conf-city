import { expect, test } from "bun:test";
import {
  advanceConstruction,
  type Construction,
  type ConstructionObservation,
  type Infrastructure,
} from "../../domain/mobility";
import type { CityLayout, WorldLayout } from "../../layout/types";
import { congestionSignals } from "./congestion";
import { trafficStats } from "./lifecycle";
import { createSim, type TrafficRoute } from "./sim";

const route: TrafficRoute = {
  key: "a-to-b",
  zone: "bridge:a|b",
  bridgeKey: "a|b",
  cityId: "a",
  targetCityId: "b",
  points: [
    [-100, 0, 0],
    [100, 0, 0],
  ],
  rateScale: 1,
};
function stoppedQueue() {
  const sim = createSim([route], 100, 0);
  sim.cars.count = 3;
  for (let i = 0; i < 3; i++) {
    sim.cars.id[i] = i + 1;
    sim.cars.x[i] = i;
    sim.cars.y[i] = 1;
  }
  return sim;
}
test("a sparse but blocked bridge triggers construction, with both city accesses", () => {
  const sim = stoppedQueue();
  const stats = trafficStats(sim);
  expect(stats.zones["bridge:a|b"]!.load).toBeLessThan(0.1);
  const signals = congestionSignals(sim, [route], stats);
  expect(signals["bridge:a|b"]!.queued).toBe(3);
  const elapsed = new Map<string, ConstructionObservation>();
  const jobs: Construction[] = [];
  for (let i = 0; i < 20; i++) {
    advanceConstruction(elapsed, jobs, { cities: {}, bridges: {} }, signals, 1);
  }
  expect(jobs[0]!.kind).toBe("bridge");
  expect(jobs[0]!.accessCities).toEqual(["a", "b"]);
});
test("inter-city traffic waiting on land upgrades the city, not the distant bridge", () => {
  const sim = stoppedQueue();
  const city = {
    outline: [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
    ],
  } as CityLayout;
  const layout = { cities: new Map([["a", city]]) } as WorldLayout;
  const signals = congestionSignals(sim, [route], trafficStats(sim), layout);
  expect(signals["city:a"]!.queued).toBe(3);
  expect(signals["bridge:a|b"]!.queued).toBe(0);
});
test("moving vehicles and separated bridge decks do not form a queue", () => {
  const sim = stoppedQueue();
  sim.cars.y[2] = 4;
  expect(congestionSignals(sim, [route], trafficStats(sim))["bridge:a|b"]!.queued).toBe(2);
  sim.cars.vel.fill(2);
  expect(congestionSignals(sim, [route], trafficStats(sim))["bridge:a|b"]!.queued).toBe(0);
});
test("short gaps preserve observation; recovery clears it and completed upgrades remain", () => {
  const elapsed = new Map<string, ConstructionObservation>();
  const jobs: Construction[] = [];
  const infra: Infrastructure = { cities: {}, bridges: {} };
  const busy = { "city:a": { load: 0.1, queued: 3 } };
  advanceConstruction(elapsed, jobs, infra, busy, 15);
  advanceConstruction(elapsed, jobs, infra, { "city:a": 0 }, 2);
  advanceConstruction(elapsed, jobs, infra, busy, 5);
  expect(jobs).toHaveLength(1);
  expect(advanceConstruction(elapsed, jobs, infra, busy, 5).completed).toHaveLength(1);
  infra.cities.a = 1;
  advanceConstruction(elapsed, jobs, infra, busy, 10);
  advanceConstruction(elapsed, jobs, infra, { "city:a": 0 }, 6);
  expect(elapsed.size).toBe(0);
  expect(infra.cities.a).toBe(1);
});
