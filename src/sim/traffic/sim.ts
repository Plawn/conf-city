import { VEHICLE_TINTS } from "../../domain/nodeStyle";
import { advanceDistance, sampleTrajectory, segmentAt } from "../mobility/trajectory";
import { trafficBudgets } from "./budget";
import { buildFrame, speedLimitAhead } from "./frame";
import { bakeJunctions, junctionSpawnClear, reserveJunctions } from "./junctions";
import { updateLifetime } from "./lifecycle";
import {
  ACCEL,
  BRAKE,
  BRAKE_LOOKAHEAD,
  CAR_SPEED,
  FOLLOW_GAIN,
  HASH_SIZE,
  LOOP_SPAWN_TRIES,
  MIN_GAP,
  MOVING,
  PATIENCE,
  PROBE_STEP,
  PROBES,
  SLOTS,
  SPAWN_GAP,
  SPAWN_JITTER,
  STALLED,
  TOKEN,
  TRUCK_SPEED,
} from "./params";
import { makePool, moveVehicle, type Pool, place, pose, type Sim, type TrafficRoute } from "./pool";
import {
  buildRouteGeom,
  CAR_LENGTH,
  type LaneGeom,
  laneGeometry,
  RIDE_HEIGHT,
  TRUCK_LENGTH,
} from "./routeGeometry";

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
