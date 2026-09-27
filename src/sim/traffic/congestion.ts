import type { ConstructionPressure } from "../../domain/mobility";
import { pointInPolygon } from "../../layout/geometry";
import type { WorldLayout } from "../../layout/types";
import type { TrafficStats } from "./lifecycle";
import type { Sim, TrafficRoute } from "./pool";

/** Assign queues to where they physically wait, including the city accesses of inter-city trips. */
export function congestionSignals(
  sim: Sim,
  routes: TrafficRoute[],
  stats: TrafficStats,
  layout?: WorldLayout,
): Record<string, ConstructionPressure> {
  const signals: Record<string, ConstructionPressure> = Object.fromEntries(
    Object.entries(stats.zones).map(([key, zone]) => [key, { load: zone.load, queued: 0 }]),
  );
  const slow: { x: number; y: number; z: number; zone: string }[] = [];
  const cells = new Map<string, number[]>();
  for (const route of routes) {
    if (route.bridgeKey && route.cityId && route.targetCityId) {
      const signal = signals[`bridge:${route.bridgeKey}`];
      if (signal) {
        signal.accessCities = [route.cityId, route.targetCityId];
      }
    }
  }
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++) {
      const r = pool.route[i]!;
      if (sim.enabled[r] === 0 || pool.retire[i]! > 0 || pool.vel[i]! > 0.35) {
        continue;
      }
      const route = routes[r];
      if (!route) {
        continue;
      }
      const x = pool.x[i]!;
      const y = pool.y[i]!;
      const z = pool.z[i]!;
      let zone = route.zone ?? "network";
      if (route.bridgeKey && layout) {
        for (const id of [route.cityId, route.targetCityId]) {
          const city = id ? layout.cities.get(id) : null;
          if (city && pointInPolygon([x, z], city.outline)) {
            zone = `city:${id}`;
            break;
          }
        }
      }
      signals[zone] ??= { load: 0, queued: 0 };
      const key = `${Math.floor(x / 6)},${Math.floor(z / 6)}`;
      const list = cells.get(key) ?? [];
      list.push(slow.length);
      cells.set(key, list);
      slow.push({ x, y, z, zone });
    }
  }
  for (const car of slow) {
    let queued = 0;
    const cx = Math.floor(car.x / 6);
    const cz = Math.floor(car.z / 6);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const index of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
          const other = slow[index]!;
          if (
            other.zone === car.zone &&
            Math.abs(other.y - car.y) < 0.65 &&
            Math.hypot(other.x - car.x, other.z - car.z) <= 6
          ) {
            queued++;
          }
        }
      }
    }
    const signal = signals[car.zone]!;
    if (queued > signal.queued) {
      signal.queued = queued;
      signal.position = [car.x, car.y, car.z];
    }
  }
  return signals;
}
