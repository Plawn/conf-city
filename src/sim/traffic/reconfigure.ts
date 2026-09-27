import { projectTrajectory } from "../mobility/trajectory";
import { place, type Sim, type TrafficRoute } from "./pool";
import { laneGeometry, RIDE_HEIGHT } from "./routeGeometry";
import { createSim } from "./sim";

/** Upgrade lanes or topology without resetting the fleet; preserve identities and lifetimes. */
export function reconfigureSim(
  previous: Sim,
  oldRoutes: TrafficRoute[],
  routes: TrafficRoute[],
  maxCars: number,
  maxTrucks: number,
): Sim {
  const next = createSim(routes, maxCars, maxTrucks, previous.random);
  const indices = new Map(routes.map((r, i) => [r.key ?? String(i), i]));
  next.nextId = previous.nextId;
  next.totals = { ...previous.totals };
  for (const [old, pool] of [
    [previous.cars, next.cars],
    [previous.trucks, next.trucks],
  ] as const) {
    for (let i = 0; i < old.count; i++) {
      const r = indices.get(oldRoutes[old.route[i]!]!.key ?? String(old.route[i]!));
      const g = r == null ? null : laneGeometry(next.geoms[r], old.lane[i]!);
      if (!g || r == null || pool.count >= pool.id.length) {
        if (old.retire[i] === 0) {
          next.totals.retired++;
        }
        continue;
      }
      const j = pool.count++;
      for (const key of Object.keys(pool) as (keyof typeof pool)[]) {
        if (key !== "count") {
          pool[key][j] = old[key][i]!;
        }
      }
      pool.route[j] = r;
      const oldGeometry = laneGeometry(previous.geoms[old.route[i]!], old.lane[i]!);
      const unchanged =
        oldGeometry &&
        g.px.length === oldGeometry.px.length &&
        g.px.every(
          (v, k) =>
            v === oldGeometry.px[k] &&
            g.py[k] === oldGeometry.py[k] &&
            g.pz[k] === oldGeometry.pz[k],
        );
      if (!unchanged) {
        pool.dist[j] = projectTrajectory(g, old.x[i]!, old.y[i]! - RIDE_HEIGHT, old.z[i]!);
      }
      // Even retained routes need a pose before the first collision frame.
      place(pool, j, g);
    }
  }
  for (let r = 0; r < oldRoutes.length; r++) {
    const i = indices.get(oldRoutes[r]!.key ?? String(r));
    if (i != null) {
      next.smoothRate[i] = previous.smoothRate[r]!;
      next.acc[i] = previous.acc[r]!;
    }
  }
  return next;
}
