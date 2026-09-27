import { sampleTrajectory } from "../mobility/trajectory";
import {
  ACCEL,
  BEHIND,
  BRAKE,
  CELL,
  CLEAR,
  COMMITTED,
  CREEP,
  ENTRY_SPEED,
  FOLLOW_GAIN,
  GAIN,
  HASH_SIZE,
  HIT_RADIUS,
  MIN_GAP,
  MOVING,
  ONCOMING,
  PROBE_STEP,
  SAME_WAY,
  SLOTS,
  STOP_SLACK,
  TIE,
  YIELD_MARGIN,
  YIELD_RADIUS,
} from "./params";
import { type Sim, support } from "./pool";
import { type LaneGeom, laneGeometry, RIDE_HEIGHT } from "./routeGeometry";

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
export function buildFrame(sim: Sim): void {
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
export function speedLimitAhead(sim: Sim, f: number, yields: boolean): number {
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
