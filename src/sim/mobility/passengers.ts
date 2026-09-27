import { mulberry32 } from "../../lib/random";
import {
  CYCLE_SECONDS,
  STATIONS,
  STOP_SECONDS,
  stationDwellRemaining,
  stationDwellStop,
} from "./metro";
import { headingOnAccess, PLATFORM_SPREAD, placeOnAccess, type StationAccess } from "./station";
import { createPose } from "./trajectory";

/**
 * The people using the metro. Pure: no Three.js, no React, no `Math.random`,
 * so the whole flow runs under `bun test`.
 *
 * The one rule everything else serves: a passenger may only disappear into a
 * rame that is *physically standing* at their station, and every dwell puts
 * people back on the platform. Both are read from `metro.ts`'s timetable, the
 * single source of truth the trains themselves use.
 */

export const Phase = { WalkIn: 0, Wait: 1, Board: 2, WalkOut: 3 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/** Units per second; the walk from street to platform is about six seconds. */
export const WALK_SPEED = 0.75;
export const FADE_SECONDS = 0.3;
export const BOARD_SECONDS = 0.45;
/** No one boards in the last moments of a dwell — the doors are closing. */
export const DOOR_CLOSE = 1.2;
export const ALIGHT_STAGGER = 0.45;
export const MAX_ALIGHT_PER_STOP = 3;
/** Population floor: a quiet city still has someone on the platform. */
export const MIN_TARGET = 9;
/** Standing slots along the platform, so waiting people do not stack up. */
const SLOTS = 6;
/** Alighters fade out over the last stretch of pavement. */
const LEAVE_FADE = 0.5;

export interface PassengerPool {
  capacity: number;
  count: number;
  station: Uint8Array;
  phase: Uint8Array;
  dist: Float64Array;
  speed: Float64Array;
  lateral: Float64Array;
  fade: Float64Array;
  timer: Float64Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  yaw: Float64Array;
  scale: Float64Array;
  /** Per station: the arrival already unloaded, so a dwell fires once. */
  lastStop: Int32Array;
  spawnAccum: Float64Array;
  slotSeq: Int32Array;
  waiting: Int32Array;
  random: () => number;
}

export interface PassengerWorld {
  accesses: StationAccess[];
  /** `MetroFleet.elapsed`, read after the trains have stepped. */
  elapsed: number;
  /** Desired live population, already clamped to the render budget. */
  target: number;
}

const pose = createPose();

export function createPassengerPool(capacity: number, seed: number): PassengerPool {
  const n = Math.max(1, Math.floor(capacity));
  return {
    capacity: n,
    count: 0,
    station: new Uint8Array(n),
    phase: new Uint8Array(n),
    dist: new Float64Array(n),
    speed: new Float64Array(n),
    lateral: new Float64Array(n),
    fade: new Float64Array(n),
    timer: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    z: new Float64Array(n),
    yaw: new Float64Array(n),
    scale: new Float64Array(n),
    lastStop: new Int32Array(STATIONS).fill(-1),
    // Primed, so the first walkers set off on the very first step
    // instead of leaving the platforms empty for the first ten seconds.
    spawnAccum: new Float64Array(STATIONS).fill(1),
    slotSeq: new Int32Array(STATIONS),
    waiting: new Int32Array(STATIONS),
    random: mulberry32(seed),
  };
}

function remove(pool: PassengerPool, i: number): void {
  const last = pool.count - 1;
  if (i !== last) {
    pool.station[i] = pool.station[last]!;
    pool.phase[i] = pool.phase[last]!;
    pool.dist[i] = pool.dist[last]!;
    pool.speed[i] = pool.speed[last]!;
    pool.lateral[i] = pool.lateral[last]!;
    pool.fade[i] = pool.fade[last]!;
    pool.timer[i] = pool.timer[last]!;
    pool.x[i] = pool.x[last]!;
    pool.y[i] = pool.y[last]!;
    pool.z[i] = pool.z[last]!;
    pool.yaw[i] = pool.yaw[last]!;
    pool.scale[i] = pool.scale[last]!;
  }
  pool.count = last;
}

/** A standing slot along the platform, taken in turn so nobody overlaps. */
function slot(pool: PassengerPool, station: number): number {
  const seq = pool.slotSeq[station]! % SLOTS;
  pool.slotSeq[station] = seq + 1;
  return (-0.5 + (seq + 0.5) / SLOTS) * PLATFORM_SPREAD;
}

function add(pool: PassengerPool, station: number, phase: Phase, dist: number): number {
  const i = pool.count++;
  pool.station[i] = station;
  pool.phase[i] = phase;
  pool.dist[i] = dist;
  pool.speed[i] = WALK_SPEED * (0.85 + pool.random() * 0.3);
  pool.lateral[i] = slot(pool, station);
  pool.fade[i] = 0;
  pool.timer[i] = 0;
  pool.scale[i] = 0;
  return i;
}

/** The track was rebuilt: keep everyone, clamped onto the new access paths. */
export function retargetPassengers(pool: PassengerPool, accesses: StationAccess[]): void {
  for (let i = pool.count - 1; i >= 0; i--) {
    const access = accesses[pool.station[i]!];
    if (!access) {
      remove(pool, i);
      continue;
    }
    pool.dist[i] = Math.min(access.walk.total, Math.max(0, pool.dist[i]!));
  }
}

export function advancePassengers(pool: PassengerPool, dt: number, world: PassengerWorld): void {
  const { accesses, elapsed, target } = world;
  if (!Number.isFinite(dt) || dt <= 0 || accesses.length === 0) {
    return;
  }
  pool.waiting.fill(0);
  for (let i = 0; i < pool.count; i++) {
    const phase = pool.phase[i]!;
    if (phase === Phase.WalkIn || phase === Phase.Wait) {
      pool.waiting[pool.station[i]!]!++;
    }
  }

  // A rame has just pulled in: people step off it. This happens whatever the
  // demand, so a station is never a still image.
  for (let s = 0; s < accesses.length; s++) {
    const stop = stationDwellStop(elapsed, s);
    if (stop < 0 || stop === pool.lastStop[s]) {
      continue;
    }
    pool.lastStop[s] = stop;
    const leaving = 1 + Math.floor(pool.random() * MAX_ALIGHT_PER_STOP);
    for (let k = 0; k < leaving && pool.count < pool.capacity; k++) {
      const i = add(pool, s, Phase.WalkOut, accesses[s]!.walk.total);
      pool.timer[i] = k * ALIGHT_STAGGER;
    }
  }

  // Arrivals from the street, paced so the population settles on `target`.
  const perStation = Math.max(1, Math.ceil(target / accesses.length));
  const room = Math.max(1, pool.capacity - MAX_ALIGHT_PER_STOP);
  for (let s = 0; s < accesses.length; s++) {
    pool.spawnAccum[s]! += (dt * target) / (accesses.length * CYCLE_SECONDS);
    while (pool.spawnAccum[s]! >= 1) {
      pool.spawnAccum[s]! -= 1;
      if (pool.waiting[s]! < perStation && pool.count < room) {
        add(pool, s, Phase.WalkIn, 0);
        pool.waiting[s]!++;
      }
    }
  }

  for (let i = pool.count - 1; i >= 0; i--) {
    const station = pool.station[i]!;
    const access = accesses[station];
    if (!access) {
      remove(pool, i);
      continue;
    }
    const total = access.walk.total;
    switch (pool.phase[i]!) {
      case Phase.WalkIn: {
        pool.fade[i] = Math.min(1, pool.fade[i]! + dt / FADE_SECONDS);
        pool.dist[i] = Math.min(total, pool.dist[i]! + pool.speed[i]! * dt);
        if (pool.dist[i]! >= total) {
          pool.phase[i] = Phase.Wait;
          // Personal hesitation, so a queue does not board as one block.
          pool.timer[i] = pool.random() * 0.9;
        }
        pool.scale[i] = pool.fade[i]!;
        break;
      }
      case Phase.Wait: {
        pool.fade[i] = Math.min(1, pool.fade[i]! + dt / FADE_SECONDS);
        pool.scale[i] = pool.fade[i]!;
        const remaining = stationDwellRemaining(elapsed, station);
        if (remaining > DOOR_CLOSE && STOP_SECONDS - remaining >= pool.timer[i]!) {
          pool.phase[i] = Phase.Board;
        }
        break;
      }
      case Phase.Board: {
        pool.fade[i]! -= dt / BOARD_SECONDS;
        pool.lateral[i]! *= Math.max(0, 1 - dt / BOARD_SECONDS);
        pool.scale[i] = Math.max(0, pool.fade[i]!);
        if (pool.fade[i]! <= 0) {
          remove(pool, i);
          continue;
        }
        break;
      }
      default: {
        pool.fade[i] = Math.min(1, pool.fade[i]! + dt / FADE_SECONDS);
        if (pool.timer[i]! > 0) {
          pool.timer[i]! -= dt;
        } else {
          pool.dist[i]! -= pool.speed[i]! * dt;
        }
        if (pool.dist[i]! <= 0) {
          remove(pool, i);
          continue;
        }
        pool.scale[i] = Math.min(pool.fade[i]!, pool.dist[i]! / LEAVE_FADE);
        break;
      }
    }
    placeOnAccess(access, pool.dist[i]!, pool.lateral[i]!, pose);
    pool.x[i] = pose.x;
    pool.y[i] = pose.y;
    pool.z[i] = pose.z;
    pool.yaw[i] =
      headingOnAccess(access, pool.dist[i]!, pose) +
      (pool.phase[i] === Phase.WalkOut ? Math.PI : 0);
  }
}
