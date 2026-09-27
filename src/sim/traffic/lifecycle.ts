import { junctionFlowing } from "./junctions";
import type { Pool, Sim } from "./pool";
import { laneGeometry } from "./routeGeometry";

export const RETIRE_SECONDS = 1.5;
export const STUCK_SECONDS = 20;
export const MAX_LIFE_SECONDS = 300;

export interface TrafficStats {
  active: number;
  budget: number;
  spawned: number;
  completed: number;
  retired: number;
  rejected: number;
  stopped: number;
  oldest: number;
  zones: Record<string, { active: number; budget: number; load: number }>;
}

export function trafficStats(sim: Sim): TrafficStats {
  let stopped = 0;
  let oldest = 0;
  const zones: TrafficStats["zones"] = {};
  for (const [zone, budget] of sim.budgets.zones) {
    zones[zone] = { active: 0, budget, load: 0 };
  }
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++) {
      if (pool.vel[i]! < 0.05) {
        stopped++;
      }
      oldest = Math.max(oldest, pool.age[i]!);
      const zone = zones[sim.zones[pool.route[i]!] ?? "network"];
      if (zone) {
        zone.active++;
      }
    }
  }
  for (const zone of Object.values(zones)) {
    zone.load = zone.active / zone.budget;
  }
  return {
    ...sim.totals,
    active: sim.cars.count + sim.trucks.count,
    budget: sim.budgets.total,
    stopped,
    oldest,
    zones,
  };
}

/** Runs for every vehicle, including vehicles stopped behind a queue. */
export function updateLifetime(sim: Sim, pool: Pool, i: number, dt: number): boolean {
  pool.age[i] = pool.age[i]! + dt;
  pool.travelled[i] = pool.travelled[i]! + pool.vel[i]! * dt;
  pool.stuck[i] = pool.vel[i]! < 0.1 ? pool.stuck[i]! + dt : 0;
  const r = pool.route[i]!;
  const loop = sim.loops[r] === 1;
  const routeTime =
    (laneGeometry(sim.geoms[r], pool.lane[i]!)?.total ?? 0) / Math.max(pool.speed[i]!, 0.1);
  const expired =
    pool.age[i]! > (loop ? 120 : Math.min(MAX_LIFE_SECONDS, Math.max(120, routeTime * 3)));
  const complete = loop && pool.travelled[i]! >= pool.tripLength[i]!;
  const stuck = pool.stuck[i]! > STUCK_SECONDS && !junctionFlowing(sim, pool, i);
  if (
    pool.retire[i]! === 0 &&
    (expired || complete || sim.enabled[r] === 0 || (stuck && sim.recoveryCooldown <= 0))
  ) {
    pool.retire[i] = RETIRE_SECONDS;
    if (complete) {
      sim.totals.completed++;
    } else {
      sim.totals.retired++;
    }
    if (stuck) {
      sim.recoveryCooldown = 1;
    }
  }
  if (pool.retire[i]! > 0) {
    pool.retire[i] = Math.max(0.00001, pool.retire[i]! - dt);
    pool.opacity[i] = pool.retire[i]! / RETIRE_SECONDS;
    return pool.retire[i]! <= 0.00001;
  }
  return false;
}
