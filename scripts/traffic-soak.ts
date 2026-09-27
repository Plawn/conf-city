/** Deterministic 24-hour simulation at the frontend's 30 Hz; no renderer or wall-clock sleeps. */
import { trafficStats } from "../src/components/traffic/lifecycle";
import { advance, createSim } from "../src/components/traffic/sim";
import { mulberry32 } from "../src/lib/random";

const hours = Number(Bun.argv[2] ?? 24);
if (!Number.isFinite(hours) || hours <= 0) {
  throw new Error("Expected a positive hour count");
}
const points: [number, number, number][] = [
  [0, 0, 0],
  [12, 0, 0],
  [12, 0, 12],
  [0, 0, 12],
  [0, 0, 0],
];
const start = performance.now();
for (const seed of [42, 1337]) {
  const sim = createSim(
    [
      { points, rateScale: 1, loop: true },
      { points: [...points].reverse(), rateScale: 1, loop: true },
    ],
    20,
    4,
    mulberry32(seed),
  );
  sim.rate.fill(3);
  sim.truckProb.fill(0.2);
  let peak = 0;
  const duration = Math.round(hours * 3600 * 30);
  for (let step = 1; step <= duration + 125 * 30; step++) {
    if (step > duration) {
      sim.rate.fill(0);
    }
    advance(sim, 1 / 30);
    peak = Math.max(peak, sim.cars.count + sim.trucks.count);
    if (step % 300 === 0) {
      const stats = trafficStats(sim);
      if (stats.active > stats.budget || stats.oldest > 122) {
        throw new Error(`Unbounded fleet: ${JSON.stringify(stats)}`);
      }
    }
    if (step % (3600 * 30) === 0) {
      console.log(JSON.stringify({ seed, hour: step / (3600 * 30), ...trafficStats(sim) }));
    }
  }
  if (sim.cars.count + sim.trucks.count !== 0) {
    throw new Error("Fleet failed to drain");
  }
  console.log(JSON.stringify({ seed, result: "PASS", hours, peak, drained: true, ...sim.totals }));
}
console.log("Simulation CPU ms:", (performance.now() - start).toFixed(1));
