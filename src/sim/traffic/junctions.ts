import { ringRadii } from "../../geo/roadStyle";
import { drivingRadius } from "../../geo/roundabouts";
import { vecKey } from "../../layout/geometry";
import type { Roundabout } from "../../layout/types";
import { createPose, sampleTrajectory } from "../mobility/trajectory";
import { type LaneGeom, laneGeometry, RIDE_HEIGHT } from "./routeGeometry";
import type { Pool, RouteGeom, Sim, TrafficRoute } from "./sim";

interface Passage {
  key: string;
  start: number;
  end: number;
}
interface Arrival {
  pool: Pool;
  i: number;
  frame: number;
  passage: Passage;
  gap: number;
}
export interface Junctions {
  routes: [Passage[], Passage[]][];
  time: number;
  progress: Map<string, number>;
  /** Vehicles currently admitted to each junction — a roundabout holds several. */
  owners: Map<string, Set<number>>;
  /** How many vehicles that roundabout's circulating lane holds at once. */
  capacity: Map<string, number>;
  caps: Float32Array;
  keys: (string | undefined)[];
  /**
   * 0 = not admitted to `keys[frame]`; otherwise the vehicle's rank in the
   * order it was admitted, 1 first. Inside one junction that order *is* the
   * priority: whoever joined the ring earlier is ahead, so a later arrival
   * gives way to it and the two never trade holds.
   */
  owns: Uint8Array;
}
const STOP = 1;
const APPROACH = 4;
const EXIT = 1;
/**
 * Centre-to-centre room one circulating vehicle takes on the ring lane —
 * `MIN_GAP` plus a margin, since a queue on a curve measures its gaps along the
 * chord. It is what turns a roundabout's circumference into an occupancy limit.
 */
const RING_SPACING = 1.4;
/**
 * How many vehicles may hold a junction at once. A roundabout is not a mutex:
 * traffic circulates one way, so entering is a *merge*, which the probe rules
 * already arbitrate (ring priority, then follow). The gate is only there to
 * keep the ring from being packed solid — admitting one vehicle at a time made
 * a roundabout run at the rate of a full traversal each, which is what made
 * them look empty and stop-start.
 */
function ringCapacity(r: Roundabout): number {
  return Math.max(1, Math.floor((2 * Math.PI * drivingRadius(r)) / RING_SPACING));
}

/** Bake the entry/exit arc lengths of each roundabout's protected crossing area. */
export function bakeJunctions(
  routes: TrafficRoute[],
  geoms: (RouteGeom | null)[],
  capacity: number,
): Junctions {
  const capacity_ = new Map<string, number>();
  for (const route of routes) {
    for (const junction of route.junctions ?? []) {
      capacity_.set(vecKey(junction.center), ringCapacity(junction));
    }
  }
  return {
    time: 0,
    progress: new Map(),
    owners: new Map(),
    capacity: capacity_,
    caps: new Float32Array(capacity),
    keys: new Array(capacity),
    owns: new Uint8Array(capacity),
    routes: routes.map((route, r) => {
      const bake = (g: LaneGeom | null): Passage[] => {
        const passages: Passage[] = [];
        if (!g) {
          return passages;
        }
        for (const junction of route.junctions ?? []) {
          const radius = ringRadii(junction).outer + 0.2;
          let current: Passage | null = null;
          for (let k = 0; k < g.dirX.length; k++) {
            const dx = g.px[k]! - junction.center[0];
            const dz = g.pz[k]! - junction.center[1];
            const a = g.dirX[k]! ** 2 + g.dirZ[k]! ** 2;
            const b = dx * g.dirX[k]! + dz * g.dirZ[k]!;
            const discriminant = b * b - a * (dx * dx + dz * dz - radius * radius);
            if (a < 1e-8 || discriminant < 0) {
              current = null;
              continue;
            }
            const length = g.cum[k + 1]! - g.cum[k]!;
            const first = Math.max(0, (-b - Math.sqrt(discriminant)) / a);
            const last = Math.min(length, (-b + Math.sqrt(discriminant)) / a);
            if (first >= last) {
              current = null;
              continue;
            }
            const start = g.cum[k]! + first;
            const end = g.cum[k]! + last;
            if (current && start - current.end < 0.01) {
              current.end = end;
            } else {
              current = { key: vecKey(junction.center), start, end };
              passages.push(current);
            }
          }
        }
        return passages.sort((a, b) => a.start - b.start);
      };
      return [bake(laneGeometry(geoms[r], 0)), bake(laneGeometry(geoms[r], 1))];
    }),
  };
}

export function junctionSpawnClear(sim: Sim, r: number, d: number, lane = 0): boolean {
  const passages = sim.junctions.routes[r]?.[lane] ?? [];
  if (passages.some((p) => d > p.start - STOP && d < p.end + EXIT)) {
    return false;
  }
  const next = passages.find((p) => p.start > d);
  if (!next) {
    return true;
  }
  const g = laneGeometry(sim.geoms[r], lane)!;
  const entry = approachPoint(g, next.start - STOP);
  let waiting = 0;
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++) {
      const otherRoute = pool.route[i]!;
      const p = sim.junctions.routes[otherRoute]?.[pool.lane[i]!]?.find(
        (p) => p.start > pool.dist[i]!,
      );
      if (!p || p.key !== next.key) {
        continue;
      }
      const other = approachPoint(
        laneGeometry(sim.geoms[otherRoute], pool.lane[i]!)!,
        p.start - STOP,
      );
      if (Math.hypot(entry[0] - other[0], entry[1] - other[1]) < 0.7) {
        waiting++;
      }
    }
  }
  return waiting < 3;
}

const sample = createPose();
function approachPoint(g: LaneGeom, d: number): [number, number] {
  sampleTrajectory(g, d, sample);
  return [sample.x, sample.z];
}

/** Waiting for a functioning give-way is not a deadlock; keep the emergency timeout for stalled junctions. */
export function junctionFlowing(sim: Sim, pool: Pool, i: number): boolean {
  const d = pool.dist[i]!;
  const passage = sim.junctions.routes[pool.route[i]!]![pool.lane[i]!]!.find(
    (p) => d < p.end + EXIT && d > p.start - APPROACH,
  );
  return (
    !!passage && sim.junctions.time - (sim.junctions.progress.get(passage.key) ?? -Infinity) < 3
  );
}

/** Space beyond the exit must be available before admitting a car, including cross-route queues. */
function exitClear(sim: Sim, arrival: Arrival): boolean {
  const g = laneGeometry(sim.geoms[arrival.pool.route[arrival.i]!], arrival.pool.lane[arrival.i]!)!;
  for (let d = arrival.passage.end; d <= Math.min(g.total, arrival.passage.end + 1.8); d += 0.3) {
    sampleTrajectory(g, d, sample);
    const x = sample.x;
    const z = sample.z;
    const y = sample.y + RIDE_HEIGHT;
    for (const pool of [sim.cars, sim.trucks]) {
      for (let i = 0; i < pool.count; i++) {
        if (pool.id[i] === arrival.pool.id[arrival.i] || Math.abs(pool.y[i]! - y) > 0.65) {
          continue;
        }
        if (pool.hx[i]! * sample.fx + pool.hz[i]! * sample.fz < -0.3) {
          continue;
        }
        if ((pool.x[i]! - x) ** 2 + (pool.z[i]! - z) ** 2 < 0.36 ** 2) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Admission to each junction. A reservation is stable — it lasts until the
 * vehicle has cleared the exit, never just a timed token — but a junction hands
 * out as many of them as its ring lane physically holds (`ringCapacity`), so
 * several vehicles circulate at once. Everyone already inside is admitted by
 * definition; waiting vehicles are let in, in id order, while there is room and
 * the space past their own exit is free (`exitClear`, the don't-block-the-box
 * rule that is what actually keeps a roundabout from locking up).
 */
export function reserveJunctions(sim: Sim, dt: number): void {
  const gates = sim.junctions;
  gates.time += dt;
  gates.caps.fill(Infinity);
  gates.owns.fill(0);
  gates.keys.fill(undefined);
  const arrivals = new Map<string, Arrival[]>();
  let frame = 0;
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++, frame++) {
      const d = pool.dist[i]!;
      const passage = gates.routes[pool.route[i]!]![pool.lane[i]!]!.find(
        (p) => d < p.end + EXIT && d > p.start - APPROACH,
      );
      if (!passage) {
        continue;
      }
      const list = arrivals.get(passage.key) ?? [];
      list.push({ pool, i, frame, passage, gap: passage.start - d });
      arrivals.set(passage.key, list);
      gates.keys[frame] = passage.key;
    }
  }
  for (const key of gates.owners.keys()) {
    if (!arrivals.has(key)) {
      gates.owners.delete(key);
    }
  }
  for (const [key, list] of arrivals) {
    const held = gates.owners.get(key) ?? new Set<number>();
    // A reservation only survives while its holder is still at this junction.
    const present = new Set(list.map((a) => a.pool.id[a.i]!));
    for (const id of [...held]) {
      if (!present.has(id)) {
        held.delete(id);
      }
    }
    // Vehicles already inside hold it whatever happens, including after a
    // geometry upgrade moved the passage under them.
    for (const a of list) {
      if (a.gap <= 0) {
        held.add(a.pool.id[a.i]!);
      }
    }
    const capacity = gates.capacity.get(key) ?? 1;
    const waiting = list
      .filter((a) => a.gap > 0 && a.gap <= STOP + 0.15 && !held.has(a.pool.id[a.i]!))
      .sort((a, b) => a.pool.id[a.i]! - b.pool.id[b.i]!);
    for (const a of waiting) {
      if (held.size >= capacity) {
        break;
      }
      if (exitClear(sim, a)) {
        held.add(a.pool.id[a.i]!);
      }
    }
    if (held.size > 0) {
      gates.owners.set(key, held);
    } else {
      gates.owners.delete(key);
    }
    const rank = new Map([...held].map((id, k) => [id, Math.min(255, k + 1)]));
    for (const a of list) {
      const mine = rank.get(a.pool.id[a.i]!);
      if (mine !== undefined) {
        gates.owns[a.frame] = mine;
        if (a.pool.vel[a.i]! > 0.1) {
          gates.progress.set(key, gates.time);
        }
      } else if (a.gap > 0) {
        gates.caps[a.frame] = Math.max(0, (a.gap - STOP) * 2);
      }
    }
  }
}
