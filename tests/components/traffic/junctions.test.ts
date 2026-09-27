import { expect, test } from "bun:test";
import { advance, createSim } from "@/components/traffic/sim";
import { mulberry32 } from "@/layout/random";
import { roundaboutRoutes } from "../../fixtures/roundabout";

for (const hz of [30, 60]) {
  for (const seed of [5, 42, 1337]) {
    test(`four saturated roundabout entrances drain without retiring cars (${hz} Hz, seed ${seed})`, () => {
      const sim = createSim(roundaboutRoutes(), 100, 20, mulberry32(seed));
      sim.rate.fill(1.2);
      let worstStopOnRing = 0;
      for (let step = 0; step < 300 * hz; step++) {
        advance(sim, 1 / hz);
        for (const pool of [sim.cars, sim.trucks]) {
          for (let i = 0; i < pool.count; i++) {
            if (sim.geoms[pool.route[i]!]!.lanes[pool.lane[i]!]!.ring[pool.seg[i]!] === 1) {
              worstStopOnRing = Math.max(worstStopOnRing, pool.stuck[i]!);
            }
          }
        }
      }
      expect(sim.totals.completed).toBeGreaterThan(40);
      expect(sim.totals.retired).toBe(0);
      expect(worstStopOnRing).toBeLessThan(2);
      sim.rate.fill(0);
      for (let step = 0; step < 100 * hz; step++) {
        advance(sim, 1 / hz);
      }
      expect(sim.cars.count + sim.trucks.count).toBe(0);
      expect(sim.totals.retired).toBe(0);
      expect(sim.totals.completed).toBe(sim.totals.spawned);
    });
  }
}

test("a roundabout circulates several vehicles at once, not one at a time", () => {
  const sim = createSim(roundaboutRoutes(), 100, 20, mulberry32(5));
  sim.rate.fill(1.2);
  let mostInside = 0;
  let completed = 0;
  for (let step = 0; step < 300 * 30; step++) {
    advance(sim, 1 / 30);
    let inside = 0;
    for (const pool of [sim.cars, sim.trucks]) {
      for (let i = 0; i < pool.count; i++) {
        // The tarmac disc of the fixture's roundabout, centred on the origin.
        if (Math.hypot(pool.x[i]!, pool.z[i]!) < 2.25) {
          inside++;
        }
      }
    }
    mostInside = Math.max(mostInside, inside);
  }
  completed = sim.totals.completed;
  // The gate used to be a mutex — one vehicle per junction, so a roundabout ran
  // at one traversal per vehicle and looked deserted. Its capacity now comes
  // from the circumference of the ring lane.
  expect(sim.junctions.capacity.get("0,0")).toBeGreaterThan(2);
  expect(mostInside).toBeGreaterThanOrEqual(3);
  expect(completed).toBeGreaterThan(150);
});

test("a vehicle waits outside the roundabout until its exit has space", async () => {
  const { reserveJunctions } = await import("@/components/traffic/junctions");
  const sim = createSim(roundaboutRoutes(), 10, 0);
  const p = sim.junctions.routes[0]![0]![0]!;
  sim.cars.count = 2;
  sim.cars.id[0] = 1;
  sim.cars.id[1] = 2;
  sim.cars.dist[0] = p.start - 1;
  sim.cars.dist[1] = p.end + 1.5;
  sim.cars.x[0] = -3.25;
  sim.cars.x[1] = 3.75;
  sim.cars.z.fill(0.25);
  sim.cars.y.fill(0.14);
  sim.cars.hx.fill(1);
  reserveJunctions(sim, 1 / 30);
  expect(sim.junctions.owners.size).toBe(0);
  expect(sim.junctions.caps[0]).toBe(0);
  sim.cars.x[1] = 7;
  sim.cars.dist[1] = sim.geoms[0]!.total - 1;
  reserveJunctions(sim, 1 / 30);
  expect([...sim.junctions.owners.get(p.key)!]).toEqual([1]);
  expect(sim.junctions.caps[0]).toBe(Infinity);
});
