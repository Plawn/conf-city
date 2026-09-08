import {
  advanceDistance,
  createPose,
  samplePose,
  sampleTrajectory,
  segmentAt,
} from "../mobility/trajectory";
import {
  buildRouteGeom,
  CAR_LENGTH,
  type LaneGeom,
  laneGeometry,
  RIDE_HEIGHT,
  type RouteGeom,
  TRUCK_LENGTH,
} from "./routeGeometry";

export type { RouteGeom } from "./routeGeometry";
export { buildRouteGeom } from "./routeGeometry";

import { VEHICLE_TINTS } from "../../domain/nodeStyle";
import type { Roundabout } from "../../layout/types";
import { trafficBudgets } from "./budget";
import { bakeJunctions, type Junctions, junctionSpawnClear, reserveJunctions } from "./junctions";
import { updateLifetime } from "./lifecycle";

/**
 * The traffic simulation — no Three.js, no React, so it runs under `bun test`.
 *
 * Vehicles follow baked routes (`RouteGeom`) in struct-of-arrays pools, one per
 * model. Each frame every vehicle lays *probes* along its own path — its
 * position, then `PROBES` points `PROBE_STEP` apart, lane offset applied — and
 * all probes of all vehicles go into one spatial hash. A vehicle then looks up
 * its own probes: another vehicle's probe within `HIT_RADIUS` of one of mine
 * means we will both be there; which of us reaches that point first, and in
 * what direction, decides my speed:
 *
 * - same direction at the point → **follow**: whoever is further from it keeps
 *   `MIN_GAP` behind the other (shared trunks, a turn onto a busy street, the
 *   two ring loops, a common driveway — no route knowledge needed);
 * - the other is on the ring lane of a roundabout *at that point* (a `ring` step —
 *   its own probe, so an entrant past its tangency counts) and I am not → **yield**
 *   (the give-way ring is painted for a reason), stopping `MIN_GAP` short of the
 *   ring lane — unless I can no longer stop short of it, in which case I drive on
 *   and the other one brakes for my body;
 * - otherwise a crossing → *priorité à droite*: I yield to what comes from my
 *   right, or to anything already on the spot;
 * - oncoming → ignore (the other lane is at least half a road away).
 *
 * Speed then eases towards the target under `ACCEL` / `BRAKE`, and is capped by
 * the curvature of the road ahead, so a car slows into a bend or a roundabout
 * and picks up again on the straight. Lane offsets are baked into the
 * path before simulation, so class changes, vertices and loop seams share
 * one continuous lane geometry for bodies, probes and admission checks.
 *
 * A vehicle held for `PATIENCE` seconds gets a priority token for a while: the
 * others yield to it if they can still stop, so a saturated main road lets the
 * side street in. Long stalls retire gradually; a finite lifetime also applies
 * to loops. Admission budgets and physical clearance discard excess demand.
 */

/**
 * One drivable path: a polyline already elevated by the caller (road y, or the
 * arch of a bridge deck, see `geo/drivable.ts`), where its lanes are, and what
 * feeds it — the throughput of a node, the ambient rate of the scene, or a
 * fixed trickle.
 */
export interface TrafficRoute {
  junctions?: Roundabout[];
  points: [number, number, number][];
  key?: string;
  zone?: string;
  cityId?: string;
  targetCityId?: string;
  bridgeKey?: string;
  ambientCityId?: string;
  /**
   * Per segment, the offsets to the driver's right of lane 0 and lane 1 (equal
   * on a single-lane road). Absent: `DEFAULT_LANE` everywhere.
   */
  lanes?: [number, number][];
  /** Per segment: the step circulates on a roundabout, and has priority over entering traffic. */
  ring?: boolean[];
  /** Node whose throughput sets the spawn rate; absent → the scene's `ambientRate`. */
  sourceAddr?: string;
  /** Multiplier on either of the above (inferred links get half the traffic). */
  rateScale: number;
  /** Fixed spawn rate in vehicles per second, ignoring `sourceAddr` and `ambientRate`. */
  rate?: number;
  /**
   * A closed path: vehicles spawn anywhere on it and wrap round instead of
   * popping at the end — the ring road's ambient traffic.
   */
  loop?: boolean;
}

/** World units per second, before the ±15 % spread. */
export const CAR_SPEED = 2.4;
export const TRUCK_SPEED = 1.8;
/** Spawn spread along the path so a burst does not leave in lockstep. */
const SPAWN_JITTER = 0.6;
/** Centre-to-centre distance a follower keeps (a vehicle is 0.55 long). */
export const MIN_GAP = 0.9;
/**
 * Probes along the vehicle's own path, `PROBE_STEP` apart; slot 0 is the vehicle
 * itself. 3.2 units of reach: a circulating vehicle must be seen by one about to
 * enter the ring while the latter can still stop short of the lane.
 */
const PROBE_STEP = 0.4;
const PROBES = 8;
const SLOTS = PROBES + 1;
/**
 * A body this close to one of my probes is on my path. Covers a tube of 0.3
 * around the path with no gap between probes (√(0.3² + 0.2²)); still under the
 * lane spacing of a boulevard (0.42), so the neighbouring lane is not followed.
 */
const HIT_RADIUS = 0.36;
/**
 * Two probes this close are the same spot. Wider than `HIT_RADIUS`: a vehicle
 * held one probe short of such a spot then keeps its body more than
 * `HIT_RADIUS` off the other's path, so the vehicle it lets through never
 * stops for it in turn. Also the reach of the hash lookup (`CELL`, 3×3 cells).
 */
const YIELD_RADIUS = 0.6;
const CELL = YIELD_RADIUS;
const HASH_SIZE = 4096;
/**
 * A vehicle with the way, due at the spot less than this long after I would
 * have cleared it (a full `MIN_GAP` past it, accelerating from where I am),
 * still gets it.
 */
const YIELD_MARGIN = 0.4;
/** Speed a vehicle is assumed to reach when working out how long it needs to clear a spot. */
const ENTRY_SPEED = 1.0;
/**
 * A yielding vehicle keeps its body this far from the path of the vehicle it
 * lets through — measured straight from the body to that vehicle's probes, not
 * along its own path, which may curl into the other's lane (a roundabout entry
 * joins the ring 0.15 after leaving the approach). A full following gap, so the
 * vehicle let through never brakes for it.
 */
const CLEAR = MIN_GAP;
/** Seconds within which two merging arrivals count as simultaneous (priority to the right decides). */
const TIE = 0.2;
/** Tolerance of `canStop` on a vehicle already parked at CLEAR. */
const STOP_SLACK = 0.05;
/**
 * A vehicle rolling with the spot this close ahead is already in it, and
 * everyone else treats it as a body on their path.
 */
const COMMITTED = PROBE_STEP;
const ACCEL = 2.5;
const BRAKE = 6;
/** Speed gained per unit of gap beyond `MIN_GAP` when following. */
const GAIN = 2;
/**
 * Gain of the following law. Stiffer than the holds: on an S-bend the chord
 * between two vehicles shrinks even at equal speed, and the steady-state error
 * of the controller is what the bumpers get — `(v_lead - v) / FOLLOW_GAIN`.
 */
const FOLLOW_GAIN = 3;
/** The curvature cap is read this far ahead, so braking starts before the bend. */
const BRAKE_LOOKAHEAD = 0.5;
/** Heading dot products: above → same way (follow); below → oncoming (ignore); between → crossing. */
const SAME_WAY = 0.5;
const ONCOMING = -0.3;
/** A vehicle less than this far ahead along my path is beside or behind me. */
const BEHIND = 0.1;
/** Speed a stopped vehicle is assumed to have when working out who reaches a spot first. */
const CREEP = 0.5;
/** Spawn clearance, centre to centre, from any vehicle already on the route. */
const SPAWN_GAP = MIN_GAP * 1.2;
/** Speed below which a held vehicle counts as stalled; above which its stall clock resets. */
const STALLED = 0.05;
const MOVING = 0.3;
/**
 * A vehicle held this long gets a priority token for `TOKEN` seconds: the others
 * yield to it if they can still stop. The token outlives its first move — a
 * clock that reset as soon as it moved would hand the turn straight back and
 * the two would creep into the junction together.
 */
const PATIENCE = 1.5;
const TOKEN = 2.0;
/** Spawn attempts on a loop before giving up for this frame. */
const LOOP_SPAWN_TRIES = 3;

/** Struct-of-arrays pool, compacted by swap-remove — index order is meaningless. */
export interface Pool {
  id: Uint32Array;
  age: Float32Array;
  travelled: Float32Array;
  tripLength: Float32Array;
  stuck: Float32Array;
  retire: Float32Array;
  opacity: Float32Array;
  route: Int32Array;
  dist: Float32Array;
  /** Cruise speed. */
  speed: Float32Array;
  /** Current speed. */
  vel: Float32Array;
  yaw: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  length: Float32Array;
  seg: Int32Array;
  tint: Uint8Array;
  /** 0 or 1: which lane the vehicle keeps where the road offers two. */
  lane: Uint8Array;
  /** Seconds spent held at a standstill. */
  stall: Float32Array;
  /** Seconds of priority token left (patience). */
  token: Float32Array;
  /** Seconds left of driving on regardless (stall release). */
  free: Float32Array;
  /** World position and horizontal heading at the end of the last frame. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  hx: Float32Array;
  hz: Float32Array;
  count: number;
}

export interface Sim {
  junctions: Junctions;
  budgets: ReturnType<typeof trafficBudgets>;
  zones: string[];
  enabled: Uint8Array;
  zoneCount: Map<string, number>;
  smoothRate: Float32Array;
  nextId: number;
  recoveryCooldown: number;
  totals: { spawned: number; completed: number; retired: number; rejected: number };
  ppy: Float32Array;
  fid: Uint32Array;
  geoms: (RouteGeom | null)[];
  loops: Uint8Array;
  /** Spawn accumulators, rates (vehicles / s) and truck share, per route. */
  acc: Float32Array;
  rate: Float32Array;
  truckProb: Float32Array;
  cars: Pool;
  trucks: Pool;
  maxCars: number;
  maxTrucks: number;
  random: () => number;
  /**
   * Per-frame scratch, indexed by frame slot (cars first, then trucks) × `SLOTS`
   * probes: probe positions and path directions, plus the hash chaining them.
   */
  ppx: Float32Array;
  ppz: Float32Array;
  pdx: Float32Array;
  pdz: Float32Array;
  pok: Uint8Array;
  /** Per probe: the probe lies on a roundabout's ring lane (a `ring` step of the route). */
  pring: Uint8Array;
  /** Per frame slot: current speed and priority token held. */
  fvel: Float32Array;
  ftoken: Uint8Array;
  /** Set by `speedLimitAhead`: the limit it returned is a hold (yield/stop), not a follow. */
  held: boolean;
  heads: Int32Array;
  next: Int32Array;
  /** Per frame slot: `tick` of the last lookup whose path this vehicle's body was on. */
  mark: Int32Array;
  tick: number;
}

function makePool(cap: number): Pool {
  return {
    id: new Uint32Array(cap),
    age: new Float32Array(cap),
    travelled: new Float32Array(cap),
    tripLength: new Float32Array(cap),
    stuck: new Float32Array(cap),
    retire: new Float32Array(cap),
    opacity: new Float32Array(cap).fill(1),
    route: new Int32Array(cap),
    dist: new Float32Array(cap),
    speed: new Float32Array(cap),
    vel: new Float32Array(cap),
    yaw: new Float32Array(cap),
    qx: new Float32Array(cap),
    qy: new Float32Array(cap),
    qz: new Float32Array(cap),
    qw: new Float32Array(cap).fill(1),
    length: new Float32Array(cap).fill(CAR_LENGTH),
    seg: new Int32Array(cap),
    tint: new Uint8Array(cap),
    lane: new Uint8Array(cap),
    stall: new Float32Array(cap),
    token: new Float32Array(cap),
    free: new Float32Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    z: new Float32Array(cap),
    hx: new Float32Array(cap),
    hz: new Float32Array(cap),
    count: 0,
  };
}

export function createSim(
  routes: TrafficRoute[],
  maxCars: number,
  maxTrucks: number,
  random: () => number = Math.random,
): Sim {
  const acc = new Float32Array(routes.length);
  for (let i = 0; i < acc.length; i++) {
    acc[i] = random(); // phase jitter between routes
  }
  const cap = maxCars + maxTrucks;
  const geoms = routes.map((r) => buildRouteGeom(r.points, r.lanes, r.ring, r.loop));
  return {
    junctions: bakeJunctions(routes, geoms, cap),
    budgets: trafficBudgets(routes, cap),
    zones: routes.map((r) => r.zone ?? "network"),
    enabled: new Uint8Array(routes.length).fill(1),
    zoneCount: new Map(),
    smoothRate: new Float32Array(routes.length),
    nextId: 1,
    recoveryCooldown: 0,
    totals: { spawned: 0, completed: 0, retired: 0, rejected: 0 },
    ppy: new Float32Array(cap * SLOTS),
    fid: new Uint32Array(cap),
    geoms,
    loops: Uint8Array.from(routes, (r) => (r.loop ? 1 : 0)),
    acc,
    rate: new Float32Array(routes.length),
    truckProb: new Float32Array(routes.length),
    cars: makePool(maxCars),
    trucks: makePool(maxTrucks),
    maxCars,
    maxTrucks,
    random,
    ppx: new Float32Array(cap * SLOTS),
    ppz: new Float32Array(cap * SLOTS),
    pdx: new Float32Array(cap * SLOTS),
    pdz: new Float32Array(cap * SLOTS),
    pok: new Uint8Array(cap * SLOTS),
    pring: new Uint8Array(cap * SLOTS),
    fvel: new Float32Array(cap),
    ftoken: new Uint8Array(cap),
    held: false,
    heads: new Int32Array(HASH_SIZE).fill(-1),
    next: new Int32Array(cap * SLOTS),
    mark: new Int32Array(cap),
    tick: 0,
  };
}

const pose = createPose();
const support = createPose();

/** Reused for spawn, movement and infrastructure changes. */
export function place(pool: Pool, i: number, g: LaneGeom): void {
  samplePose(g, pool.dist[i]!, pool.length[i]!, pose, support);
  pool.seg[i] = pose.segment;
  pool.x[i] = pose.x;
  pool.y[i] = pose.y + RIDE_HEIGHT;
  pool.z[i] = pose.z;
  pool.qx[i] = pose.qx;
  pool.qy[i] = pose.qy;
  pool.qz[i] = pose.qz;
  pool.qw[i] = pose.qw;
  pool.yaw[i] = Math.atan2(pose.fx, pose.fz);
  // Collision headings follow the local path tangent, as do anticipation probes.
  sampleTrajectory(g, pool.dist[i]!, support);
  const horizontal = Math.hypot(support.fx, support.fz);
  pool.hx[i] = horizontal > 1e-6 ? support.fx / horizontal : Math.sin(pool.yaw[i]!);
  pool.hz[i] = horizontal > 1e-6 ? support.fz / horizontal : Math.cos(pool.yaw[i]!);
}

/** Nobody of the same route within `MIN_GAP` (and a bit) of arc length `d`. */
/**
 * Whether a vehicle may appear at arc length `d` of the route: -1 when another
 * one is within `SPAWN_GAP`, otherwise the speed it should start at so as not
 * to run into the vehicle ahead of it (`Infinity` when the road is clear). A
 * spawn is a car pulling out, not a car materialising at cruise speed.
 */
function spawnClearance(sim: Sim, routeIdx: number, g: LaneGeom, d: number, lane: number): number {
  if (!junctionSpawnClear(sim, routeIdx, d, lane)) {
    return -1;
  }
  const loop = sim.loops[routeIdx] === 1;
  sampleTrajectory(g, d, pose);
  const x = pose.x;
  const z = pose.z;
  const y = pose.y + RIDE_HEIGHT;
  let limit = Infinity;
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++) {
      if (
        Math.abs(pool.y[i]! - y) < 0.65 &&
        Math.hypot(pool.x[i]! - x, pool.z[i]! - z) < SPAWN_GAP
      ) {
        return -1;
      }
      if (pool.route[i] !== routeIdx || laneGeometry(sim.geoms[routeIdx], pool.lane[i]!) !== g) {
        continue;
      }
      let ahead = pool.dist[i]! - d;
      if (loop) {
        ahead = ((ahead % g.total) + g.total) % g.total;
        if (ahead > g.total - SPAWN_GAP) {
          return -1; // just behind me on the loop
        }
      }
      if (Math.abs(ahead) < SPAWN_GAP) {
        return -1;
      }
      if (ahead > 0 && ahead < PROBES * PROBE_STEP) {
        limit = Math.min(limit, pool.vel[i]! + (ahead - MIN_GAP) * FOLLOW_GAIN);
      }
    }
  }
  return limit;
}

/**
 * Appends one vehicle to the pool at arc length `d`; returns its slot. The
 * caller has checked capacity and clearance.
 */
function spawnAt(
  sim: Sim,
  pool: Pool,
  routeIdx: number,
  g: LaneGeom,
  baseSpeed: number,
  d: number,
  velLimit: number,
  lane: number,
): number {
  const i = pool.count++;
  pool.id[i] = sim.nextId++;
  pool.age[i] = 0;
  pool.travelled[i] = 0;
  pool.stuck[i] = 0;
  pool.retire[i] = 0;
  pool.opacity[i] = 1;
  pool.tripLength[i] = g.total * (sim.random() < 0.5 ? 1 : 2);
  sim.totals.spawned++;
  const s = segmentAt(g, d, 0);
  pool.route[i] = routeIdx;
  pool.dist[i] = d;
  pool.speed[i] = baseSpeed * (0.85 + sim.random() * 0.3);
  pool.vel[i] = Math.max(0, Math.min(pool.speed[i]! * g.cap[s]!, velLimit));
  pool.seg[i] = s;
  pool.tint[i] = (sim.random() * VEHICLE_TINTS.length) | 0;
  pool.lane[i] = lane;
  pool.length[i] = baseSpeed === TRUCK_SPEED ? TRUCK_LENGTH : CAR_LENGTH;
  pool.stall[i] = 0;
  pool.token[i] = 0;
  pool.free[i] = 0;
  place(pool, i, g);
  return i;
}

function moveVehicle(pool: Pool, dst: number, src: number): void {
  pool.id[dst] = pool.id[src]!;
  pool.age[dst] = pool.age[src]!;
  pool.travelled[dst] = pool.travelled[src]!;
  pool.tripLength[dst] = pool.tripLength[src]!;
  pool.stuck[dst] = pool.stuck[src]!;
  pool.retire[dst] = pool.retire[src]!;
  pool.opacity[dst] = pool.opacity[src]!;
  pool.route[dst] = pool.route[src]!;
  pool.dist[dst] = pool.dist[src]!;
  pool.speed[dst] = pool.speed[src]!;
  pool.vel[dst] = pool.vel[src]!;
  pool.yaw[dst] = pool.yaw[src]!;
  pool.qx[dst] = pool.qx[src]!;
  pool.qy[dst] = pool.qy[src]!;
  pool.qz[dst] = pool.qz[src]!;
  pool.qw[dst] = pool.qw[src]!;
  pool.length[dst] = pool.length[src]!;
  pool.seg[dst] = pool.seg[src]!;
  pool.tint[dst] = pool.tint[src]!;
  pool.lane[dst] = pool.lane[src]!;
  pool.stall[dst] = pool.stall[src]!;
  pool.token[dst] = pool.token[src]!;
  pool.free[dst] = pool.free[src]!;
  pool.x[dst] = pool.x[src]!;
  pool.y[dst] = pool.y[src]!;
  pool.z[dst] = pool.z[src]!;
  pool.hx[dst] = pool.hx[src]!;
  pool.hz[dst] = pool.hz[src]!;
}

const probe = new Float32Array(6);

/**
 * Point of the vehicle's own baked lane `ahead` further on, and its horizontal
 * direction there. False when the path ends
 * before that.
 */
function sampleAhead(
  g: LaneGeom,
  loop: boolean,
  d0: number,
  ahead: number,
  out: Float32Array,
): boolean {
  const d = d0 + ahead;
  if (!loop && d >= g.total) {
    return false;
  }
  sampleTrajectory(g, d, support);
  out[0] = support.x;
  out[1] = support.z;
  const hlen = Math.hypot(support.fx, support.fz);
  out[2] = hlen > 1e-6 ? support.fx / hlen : 0;
  out[3] = hlen > 1e-6 ? support.fz / hlen : 1;
  out[4] = g.ring[support.segment]!;
  out[5] = support.y + RIDE_HEIGHT;
  return true;
}

function cellHash(cx: number, cz: number): number {
  return ((cx * 73856093) ^ (cz * 19349663)) & (HASH_SIZE - 1);
}

function hashProbe(sim: Sim, slot: number): void {
  const h = cellHash(Math.floor(sim.ppx[slot]! / CELL), Math.floor(sim.ppz[slot]! / CELL));
  sim.next[slot] = sim.heads[h]!;
  sim.heads[h] = slot;
}

/** Lays every vehicle's probes and rebuilds the spatial hash over them. */
function buildFrame(sim: Sim): void {
  sim.heads.fill(-1);
  let f = 0;
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++, f++) {
      const g = laneGeometry(sim.geoms[pool.route[i]!], pool.lane[i]!);
      const loop = sim.loops[pool.route[i]!] === 1;
      sim.fvel[f] = pool.vel[i]!;
      sim.fid[f] = pool.id[i]!;
      sim.ftoken[f] = pool.token[i]! > 0 ? 1 : 0;
      const base = f * SLOTS;
      sim.ppx[base] = pool.x[i]!;
      sim.ppy[base] = pool.y[i]!;
      sim.ppz[base] = pool.z[i]!;
      sim.pdx[base] = pool.hx[i]!;
      sim.pdz[base] = pool.hz[i]!;
      sim.pok[base] = 1;
      sim.pring[base] = g ? g.ring[pool.seg[i]!]! : 0;
      hashProbe(sim, base);
      for (let k = 1; k < SLOTS; k++) {
        const slot = base + k;
        if (g && sampleAhead(g, loop, pool.dist[i]!, PROBE_STEP * k, probe)) {
          sim.ppx[slot] = probe[0]!;
          sim.ppy[slot] = probe[5]!;
          sim.ppz[slot] = probe[1]!;
          sim.pdx[slot] = probe[2]!;
          sim.pdz[slot] = probe[3]!;
          sim.pring[slot] = probe[4]!;
          sim.pok[slot] = 1;
          hashProbe(sim, slot);
        } else {
          sim.pok[slot] = 0;
        }
      }
    }
  }
}

/**
 * Seconds a vehicle at speed `v` needs to be a full `MIN_GAP` past a spot
 * `dist` ahead, accelerating at `ACCEL` up to `ENTRY_SPEED` (or its current
 * speed if faster) — how long it blocks the spot for whoever has the way.
 */
function timeToClear(v: number, dist: number): number {
  const s = dist + MIN_GAP;
  const vmax = Math.max(v, ENTRY_SPEED);
  const t1 = (vmax - v) / ACCEL;
  const s1 = v * t1 + (ACCEL * t1 * t1) / 2;
  if (s <= s1) {
    return (Math.sqrt(v * v + 2 * ACCEL * s) - v) / ACCEL;
  }
  return t1 + (s - s1) / vmax;
}

/** Squared distance from the body at slot `fb` to the nearest probe of the vehicle at slot `jb`. */
function pathDist2(sim: Sim, jb: number, fb: number): number {
  let near = Infinity;
  for (let kk = 0; kk < SLOTS && sim.pok[jb + kk]; kk++) {
    if (Math.abs(sim.ppy[jb + kk]! - sim.ppy[fb]!) > 0.65) {
      continue;
    }
    const nx = sim.ppx[jb + kk]! - sim.ppx[fb]!;
    const nz = sim.ppz[jb + kk]! - sim.ppz[fb]!;
    near = Math.min(near, nx * nx + nz * nz);
  }
  return near;
}

/**
 * How far the vehicle at slot `fb` may still go before coming within CLEAR of
 * the path of the vehicle at slot `jb` — measured along *my own* probe chain:
 * the first of my probes closer than CLEAR to any of theirs is where I must not
 * be, and I stop one probe earlier (interpolated). Measuring from my body only
 * (`pathDist2`) is not enough: their chain grows towards me as they arrive, so a
 * body already creeping into a tangent blend reads as clear until it is not.
 */
function holdCap(sim: Sim, jb: number, fb: number): number {
  let prev = Infinity;
  for (let k = 0; k < SLOTS && sim.pok[fb + k]; k++) {
    const d = Math.sqrt(pathDist2(sim, jb, fb + k));
    if (d < CLEAR) {
      if (k === 0) {
        return d - CLEAR;
      }
      // Probe k-1 was clear, probe k is not: stop where the line between them crosses CLEAR.
      const t = prev - d > 1e-6 ? (prev - CLEAR) / (prev - d) : 0;
      return (k - 1 + Math.min(1, Math.max(0, t))) * PROBE_STEP;
    }
    prev = d;
  }
  return Infinity;
}

/** Whether the path ahead of the vehicle at slot `jb` runs through the body at slot `fb`. */
/** Can a vehicle at `v` still stop CLEAR short of a path `dist2` (squared) away? */
function canStop(v: number, dist2: number): boolean {
  // A vehicle parked exactly CLEAR short of the path (its hold cap put it there)
  // has stopped already: a little slack keeps that from reading as "cannot".
  const room = Math.max(0, Math.sqrt(dist2) - CLEAR + STOP_SLACK);
  return room * 2 * BRAKE >= v * v;
}

function pathThrough(sim: Sim, jb: number, fb: number): boolean {
  return pathDist2(sim, jb, fb) < HIT_RADIUS * HIT_RADIUS;
}

/**
 * Speed the vehicle in frame slot `f` should aim for, from every spot where its
 * probes meet another vehicle's. `Infinity` when the way is clear.
 *
 * Two passes over the same neighbourhood. First the *bodies* on my path: a
 * vehicle ahead of me on my own lane is followed, one crossing it is stopped
 * for. Then the *probes* of the vehicles whose body is not on my path — the
 * ones about to join it or cross it — where priority decides who holds back.
 * A vehicle followed in the first pass is skipped in the second: its probes
 * are further along my own lane, and a spot-by-spot timing rule would slow the
 * whole queue behind a slow leader.
 */
function speedLimitAhead(sim: Sim, f: number, yields: boolean): number {
  let limit = Infinity;
  sim.held = false;
  /** Where along my path the nearest *standing* body ahead will stop me (first pass). */
  let stopAt = Infinity;
  const tick = ++sim.tick;
  if (tick === 0x7fffffff) {
    sim.mark.fill(0);
    sim.tick = 1;
  }
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1 && !yields) {
      break;
    }
    for (let k = 1; k < SLOTS; k++) {
      const slot = f * SLOTS + k;
      if (!sim.pok[slot]) {
        break;
      }
      const px = sim.ppx[slot]!;
      const pz = sim.ppz[slot]!;
      const dx = sim.pdx[slot]!;
      const dz = sim.pdz[slot]!;
      const myDist = PROBE_STEP * k;
      /** Whether I am on a ring lane *at this spot* — an entrant's probes past the tangency are. */
      const mine = sim.pring[slot]! === 1;
      const cx = Math.floor(px / CELL);
      const cz = Math.floor(pz / CELL);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          for (let q = sim.heads[cellHash(cx + ox, cz + oz)]!; q !== -1; q = sim.next[q]!) {
            const j = (q / SLOTS) | 0;
            const kj = q - j * SLOTS;
            if (
              j === f ||
              (pass === 0) !== (kj === 0) ||
              Math.abs(sim.ppy[q]! - sim.ppy[slot]!) > 0.65
            ) {
              continue;
            }
            // Inside one junction, admission order settles it: I ignore the
            // holds of anyone admitted after me (or not admitted at all), so a
            // roundabout with several vehicles on it resolves by rank rather
            // than by two of them yielding to each other.
            if (pass === 1 && sim.junctions.keys[f] === sim.junctions.keys[j]) {
              const mine = sim.junctions.owns[f]!;
              const theirs = sim.junctions.owns[j]!;
              if (mine && (!theirs || theirs > mine)) {
                continue;
              }
            }
            const ex = sim.ppx[q]! - px;
            const ez = sim.ppz[q]! - pz;
            const radius = pass === 0 ? HIT_RADIUS : YIELD_RADIUS;
            if (ex * ex + ez * ez > radius * radius) {
              continue;
            }
            const h = dx * sim.pdx[q]! + dz * sim.pdz[q]!;
            if (h < ONCOMING) {
              continue;
            }
            let cap: number;
            if (kj === 0) {
              // The other vehicle's body is on my path.
              const along = myDist + (ex * dx + ez * dz);
              if (h > SAME_WAY) {
                if (along < BEHIND) {
                  continue; // beside or behind me on my own lane
                }
                sim.mark[j] = tick;
                if (sim.fvel[j]! < MOVING) {
                  stopAt = Math.min(stopAt, along - MIN_GAP);
                }
                // On an S-bend the chord is shorter than the path: keep the
                // straight-line gap too, that is what the bumpers measure.
                const jb = j * SLOTS;
                const fb = f * SLOTS;
                const gap = Math.min(
                  along,
                  Math.hypot(sim.ppx[jb]! - sim.ppx[fb]!, sim.ppz[jb]! - sim.ppz[fb]!),
                );
                cap = sim.fvel[j]! + (gap - MIN_GAP) * FOLLOW_GAIN; // follow it
              } else if (yields) {
                if (sim.fvel[j]! < MOVING) {
                  stopAt = Math.min(stopAt, along - MIN_GAP);
                }
                cap = (along - MIN_GAP) * GAIN; // stop short of it, whoever it is
              } else {
                continue;
              }
            } else {
              if (sim.mark[j] === tick) {
                continue; // already following it
              }
              const jb = j * SLOTS;
              const fb = f * SLOTS;
              const bx = sim.ppx[jb]! - sim.ppx[fb]!;
              const bz = sim.ppz[jb]! - sim.ppz[fb]!;
              if (bx * sim.pdx[fb]! + bz * sim.pdz[fb]! < 0 && pathThrough(sim, jb, fb)) {
                sim.mark[j] = tick;
                continue; // queued behind me, its path runs through my body: it follows me
              }
              // We are both heading for the same spot: who holds back?
              const theirDist = PROBE_STEP * kj;
              if (theirDist <= COMMITTED && sim.fvel[j]! > MOVING) {
                // Rolling into the spot, as good as a body there: follow or stop
                // short — of the body itself, not of the spot it is rolling into.
                // A vehicle *held* one probe short of it is not in it.
                const gapB = Math.min(
                  myDist,
                  Math.hypot(sim.ppx[jb]! - sim.ppx[fb]!, sim.ppz[jb]! - sim.ppz[fb]!),
                );
                cap = (gapB - MIN_GAP) * FOLLOW_GAIN + (h > SAME_WAY ? sim.fvel[j]! : 0);
                if (cap < limit) {
                  limit = cap;
                  sim.held = h <= SAME_WAY;
                }
                continue;
              }
              let hold: boolean;
              const theirTime = theirDist / Math.max(sim.fvel[j]!, CREEP);
              /** Whether the other one is on the ring lane at the spot — its body may still be on its approach. */
              const theirs = sim.pring[q]! === 1;
              if (theirs && !mine) {
                // Circulating traffic has the way unless I am clear of the spot before it.
                hold = theirTime < timeToClear(sim.fvel[f]!, myDist) + YIELD_MARGIN;
              } else if (mine && !theirs) {
                hold = false; // circulating: the entering vehicle waits
              } else if (h <= SAME_WAY) {
                // Plain crossing: priority to what comes from my right — my right is (-dz, dx).
                const fromRight = sim.pdx[q]! * -dz + sim.pdz[q]! * dx < 0;
                hold = fromRight && theirTime < timeToClear(sim.fvel[f]!, myDist) + YIELD_MARGIN;
              } else {
                // Two lanes merging: the later one holds back (a stopped vehicle is
                // assumed to creep, or two vehicles waiting for each other would
                // wait forever). Close call: the one coming from the right goes —
                // the same answer the crossing rule gives this pair one spot
                // earlier, or the two rules would deadlock at the corner.
                const myTime = myDist / Math.max(sim.fvel[f]!, CREEP);
                const rx = sim.ppx[jb]! - sim.ppx[fb]!;
                const rz = sim.ppz[jb]! - sim.ppz[fb]!;
                const bodyRight = rx * -sim.pdz[fb]! + rz * sim.pdx[fb]! > 0;
                hold = theirTime < myTime - TIE || (theirTime < myTime + TIE && bodyRight);
              }
              // A priority token flips a decision abruptly, so it only flips
              // towards a hold the yielder can still brake for — both sides run
              // the same test, so the holder goes exactly when the other holds.
              const theirToken = sim.ftoken[j] && (!sim.ftoken[f] || sim.fid[j]! < sim.fid[f]!);
              const myToken = sim.ftoken[f] && !theirToken;
              if (theirToken) {
                if (myDist > COMMITTED && canStop(sim.fvel[f]!, pathDist2(sim, jb, fb))) {
                  hold = true; // it has waited long enough: let it in
                }
              } else if (myToken) {
                if (canStop(sim.fvel[j]!, pathDist2(sim, fb, jb))) {
                  hold = false; // I have waited long enough: it lets me in
                }
              }
              if (!hold && (h <= SAME_WAY || (theirs && !mine)) && stopAt < myDist + MIN_GAP) {
                // Don't block the box: a standing queue ahead would stop me on
                // its lane. Wait outside it until there is room to clear the spot.
                hold = true;
              }
              if (hold && !canStop(sim.fvel[f]!, pathDist2(sim, jb, fb))) {
                // Past the point of no return: a hold now would stop me *in*
                // its lane. Drive on; it sees my body and brakes for it.
                hold = false;
              }
              if (!hold) {
                continue; // I have the way; the other one adapts
              }
              // Wait clear of its path until it has gone by.
              cap = holdCap(sim, jb, fb) * GAIN;
            }
            if (cap < limit) {
              limit = cap;
              // Following a queue is not being held: the stall clock (patience,
              // release) only runs while a yield rule keeps me stopped.
              sim.held = pass === 1 || h <= SAME_WAY;
            }
          }
        }
      }
    }
  }
  return Math.max(0, limit);
}

/** Decides every vehicle's speed for this frame from the frame arrays. Does not move anyone. */
function decide(sim: Sim, pool: Pool, firstFrameIndex: number, dt: number): void {
  for (let i = 0; i < pool.count; i++) {
    const g = laneGeometry(sim.geoms[pool.route[i]!], pool.lane[i]!);
    if (!g) {
      continue;
    }
    const s = pool.seg[i]!;
    const ahead = segmentAt(g, advanceDistance(g, pool.dist[i]!, BRAKE_LOOKAHEAD, 1), s);
    let target = pool.speed[i]! * Math.min(g.cap[s]!, g.cap[ahead]!);

    if (pool.token[i]! > 0) {
      pool.token[i] = pool.token[i]! - dt;
    }
    const limit = Math.min(
      speedLimitAhead(sim, firstFrameIndex + i, true),
      sim.junctions.caps[firstFrameIndex + i]!,
    );
    if (limit < Infinity) {
      target = Math.min(target, limit);
      if (sim.held && pool.vel[i]! < STALLED) {
        const was = pool.stall[i]!;
        pool.stall[i] = was + dt;
        if (was <= PATIENCE && pool.stall[i]! > PATIENCE) {
          pool.token[i] = TOKEN;
        }
      }
    }
    if (pool.vel[i]! > MOVING) {
      pool.stall[i] = 0;
    }
    const dv = target - pool.vel[i]!;
    pool.vel[i] = pool.vel[i]! + Math.max(-BRAKE * dt, Math.min(ACCEL * dt, dv));
  }
}

/**
 * Advances every vehicle of one pool at its decided speed and updates its
 * position and yaw. Returns true when a slot changed occupant (swap-remove).
 */
function move(sim: Sim, pool: Pool, dt: number): boolean {
  let dirty = false;
  let i = 0;
  while (i < pool.count) {
    const g = laneGeometry(sim.geoms[pool.route[i]!], pool.lane[i]!);
    let d = g ? pool.dist[i]! + pool.vel[i]! * dt : Infinity;
    if (g && d >= g.total && sim.loops[pool.route[i]!]) {
      // A loop closes on its own first point: wrap and start the segment scan over.
      d = advanceDistance(g, pool.dist[i]!, pool.vel[i]!, dt);
      pool.seg[i] = 0;
    }
    const retired = updateLifetime(sim, pool, i, dt);
    if (!g || d >= g.total || retired) {
      if (!retired && pool.retire[i] === 0) {
        sim.totals.completed++;
      }
      // Reached the far end (or the route vanished): pop, no fade — swap-remove.
      const last = --pool.count;
      if (last !== i) {
        moveVehicle(pool, i, last);
        dirty = true;
      }
      continue; // the moved vehicle now sits in this slot
    }
    pool.dist[i] = advanceDistance(g, pool.dist[i]!, pool.vel[i]!, dt);
    pool.seg[i] = segmentAt(g, d, pool.seg[i]!);
    place(pool, i, g);

    i++;
  }
  return dirty;
}

/** Spawns what the rates owe this frame. Returns true when a car slot was filled. */
function spawnAll(sim: Sim, dt: number): boolean {
  let carsDirty = false;
  for (let r = 0; r < sim.geoms.length; r++) {
    const route = sim.geoms[r];
    if (!route) {
      continue;
    }
    const loop = sim.loops[r] === 1;
    sim.smoothRate[r] =
      sim.smoothRate[r]! +
      (Math.max(0, sim.rate[r]!) - sim.smoothRate[r]!) * (1 - Math.exp(-dt / 5));
    if (sim.enabled[r] === 0 || sim.rate[r]! <= 0) {
      sim.acc[r] = 0;
      continue;
    }
    let a = sim.acc[r]! + Math.min(8, sim.smoothRate[r]!) * dt;
    while (a >= 1) {
      const zone = sim.zones[r]!;
      if (
        sim.cars.count + sim.trucks.count >= sim.budgets.total ||
        (sim.zoneCount.get(zone) ?? 0) >= (sim.budgets.zones.get(zone) ?? 0)
      ) {
        sim.totals.rejected++;
        a %= 1;
        break;
      }
      const truck = sim.random() < sim.truckProb[r]!;
      const pool = truck ? sim.trucks : sim.cars;
      const cap = truck ? sim.maxTrucks : sim.maxCars;
      if (pool.count >= cap) {
        a -= 1; // a full pool drops the vehicle rather than queueing a burst
        continue;
      }
      const lane = sim.random() < 0.5 ? 1 : 0;
      const g = route.lanes[lane]!;
      let d = -1;
      let velLimit = Infinity;
      for (let attempt = 0; attempt < (loop ? LOOP_SPAWN_TRIES : 1); attempt++) {
        const candidate = loop ? sim.random() * g.total : sim.random() * SPAWN_JITTER;
        velLimit = spawnClearance(sim, r, g, candidate, lane);
        if (velLimit >= 0) {
          d = candidate;
          break;
        }
      }
      if (d < 0) {
        sim.totals.rejected++;
        a %= 1; // discard demand; never replay a backlog
        break;
      }
      spawnAt(sim, pool, r, g, truck ? TRUCK_SPEED : CAR_SPEED, d, velLimit, lane);
      sim.zoneCount.set(zone, (sim.zoneCount.get(zone) ?? 0) + 1);
      carsDirty = carsDirty || !truck;
      a -= 1;
    }
    sim.acc[r] = a;
  }
  return carsDirty;
}

/**
 * One simulation step. Returns whether car slots changed occupant, i.e. the
 * caller must re-upload the cars' instance colours.
 */
export function advance(sim: Sim, dt: number): { carsDirty: boolean } {
  sim.recoveryCooldown = Math.max(0, sim.recoveryCooldown - dt);
  sim.zoneCount.clear();
  for (const pool of [sim.cars, sim.trucks]) {
    for (let i = 0; i < pool.count; i++) {
      const zone = sim.zones[pool.route[i]!]!;
      sim.zoneCount.set(zone, (sim.zoneCount.get(zone) ?? 0) + 1);
    }
  }
  let carsDirty = spawnAll(sim, dt);
  buildFrame(sim);
  reserveJunctions(sim, dt);
  decide(sim, sim.cars, 0, dt);
  decide(sim, sim.trucks, sim.cars.count, dt);
  carsDirty = move(sim, sim.cars, dt) || carsDirty;
  move(sim, sim.trucks, dt);
  return { carsDirty };
}
