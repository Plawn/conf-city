import { vecKey } from "../../layout/geometry";
import type { Roundabout, Vec2 } from "../../layout/types";
import { TAU } from "../../lib/math";
import { arcPiece, MAX_TURN, MIN_DRIVEN_RADIUS, type PathPiece, samplePath } from "./path";
import { CLASS_STYLE, maxLaneOffset, ringRadii } from "./roadStyle";

/**
 * Sends a drivable route *around* the roundabouts it meets instead of straight
 * through them.
 *
 * `buildRoadNetwork` routes on the corner lattice, so a route that crosses a
 * junction has that corner as one of its points — and the corner is exactly
 * where the renderer plants the roundabout island. Driven literally, the path
 * runs through the middle of a raised opaque disc: vehicles sink into the
 * terre-plein and vanish for its whole width, which on a final approach reads as
 * never arriving at all.
 *
 * Each junction point is therefore replaced by an arc of the tarmac ring, from
 * the bearing of the incoming leg to the bearing of the outgoing one. Circulation
 * is always in the same rotational direction — that is what a roundabout *is*,
 * and it means a right turn is a quarter turn while a left turn goes three
 * quarters of the way round, exactly as on the road.
 *
 * The legs meet the ring *tangentially*: a leg is radial, so joining the ring
 * where the leg crosses it would be a 90° corner — the vehicle's lane offset
 * would jump sideways by half a car while its yaw catches up, which is the
 * "sliding into the roundabout" look. Instead the path leaves the leg early on a
 * small circle of radius `entryRadius`, tangent to the leg and externally
 * tangent to the driving circle, and kisses the ring `φ` past the leg's bearing.
 * The exit mirrors it.
 *
 * Two things decide whether that blend is possible at all, and both used to be
 * silently wrong:
 *
 * - **The blend circle must be wide enough to carry the outer lane.** On the
 *   blend the vehicle turns *against* the circulation, so its lane offset eats
 *   into the small radius: a boulevard's outer lane sits 0.70 from the
 *   centreline, which on the old fixed 0.6 circle meant a *negative* driven
 *   radius — the path folded back on itself and the car appeared to reverse.
 *   `entryRadius` is therefore derived from the class's own widest lane.
 * - **The leg must be long enough to leave the ring on.** The lattice gives
 *   long legs, but the ring road is finely tessellated, so a roundabout sitting
 *   on it often has its neighbouring ring vertices *inside its own tarmac*.
 *   Those points are not drivable — they are under the island — and aiming the
 *   arc at them produced a radial join and a hairpin of up to 171°. They are
 *   dropped (`trimIntoRoundabouts`) and the arc aims at the first neighbour
 *   genuinely outside, which is also what makes the tangent blend fit.
 *
 * Matching is by exact coordinate, the invariant `RoadRoute` already relies on:
 * corner positions and roundabout centres come from the same arithmetic, and
 * `layoutWorld` translates both by the same offset. A bridgehead is no special
 * case: `geo/drivable.ts` splices the deck end in as the next point, so the
 * arc simply exits along the deck — the deck end itself is never moved.
 */

/** Floor on the blend circle, whatever the class allows. */
const BASE_ENTRY_RADIUS = 0.6;
/** Below this the blend is not worth its points: keep the plain radial join. */
const MIN_ENTRY_RADIUS = 0.2;
/** Chord bound of the sampled arcs; `MAX_TURN` is what actually binds on the blends. */
const ARC_CHORD = 0.3;
/** The blend must end this far short of the leg's far end (a deck end, a mouth). */
const LEG_MARGIN = 0.05;
/**
 * How far past the tarmac's outer edge a point still counts as part of the
 * roundabout: the entry tangent point can sit up to ≈ 0.1 outside `outer`
 * (street-class ring), and the step onto it must be seen as the roundabout's.
 */
const APPROACH = 0.3;

/**
 * Traffic circulates counter-clockwise seen from above — the right-hand-drive
 * convention, and the one the vehicles' own lane offset already assumes. With
 * `+X` right and `+Z` towards the bottom of that view, that is *decreasing*
 * `atan2(z, x)`.
 */
const CIRCULATION = -1;

/** Centreline of the ring: the middle of the tarmac, clear of the island. */
export function drivingRadius(r: Roundabout): number {
  const { inner } = ringRadii(r);
  return inner + CLASS_STYLE[r.klass].width / 2;
}

/**
 * Radius of the circle a vehicle leaves its leg on. Wide enough that the
 * class's outer lane, which rides on the *inside* of that circle, still turns
 * on `MIN_DRIVEN_RADIUS`.
 */
export function entryRadius(r: Roundabout): number {
  return Math.max(BASE_ENTRY_RADIUS, maxLaneOffset(r.klass) + MIN_DRIVEN_RADIUS);
}

/** Distance along the leg of the tangent point of a blend of radius `rho`. */
function tangentDistance(R: number, rho: number): number {
  return Math.sqrt(R * R + 2 * R * rho);
}

/**
 * How far from the centre a route point has to be for the arc to aim at it:
 * outside the tarmac, and far enough that the full blend still fits.
 */
function legReach(r: Roundabout): number {
  const R = drivingRadius(r);
  // `roundaboutAround` — and so `drivable.ts`'s corner rounding — counts
  // everything within `outer + APPROACH` as part of the roundabout and refuses
  // to round it. A surviving point inside that band would therefore keep a
  // sharp corner nothing ever smooths, so the trim reaches at least that far.
  return Math.max(ringRadii(r).outer + APPROACH, tangentDistance(R, entryRadius(r)) + LEG_MARGIN);
}

/**
 * The roundabout whose tarmac (plus the approach where its blends start) covers
 * `p`, if any. This is the test for "is this point of a drivable path part of
 * a roundabout" — blend points are *not* on the driving radius, so an exact
 * radius test would miss them.
 */
export function roundaboutAround(p: Vec2, roundabouts: Roundabout[]): Roundabout | undefined {
  return roundabouts.find(
    (r) => Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) <= ringRadii(r).outer + APPROACH,
  );
}

/** The roundabout whose driving circle `p` sits on exactly — a point of the circulating arc. */
export function roundaboutArcAt(p: Vec2, roundabouts: Roundabout[]): Roundabout | undefined {
  return roundabouts.find(
    (r) => Math.abs(Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) - drivingRadius(r)) < 1e-4,
  );
}

/**
 * The blend a leg of length `legLen` (from the centre) can afford: radius `ρ`,
 * the angle `φ` the touch point sits past the leg's bearing, and the distance
 * `t` of the tangent point along the leg. `ρ = 0` when the leg is too short.
 */
function blend(R: number, legLen: number, want: number): { rho: number; phi: number; t: number } {
  const L = legLen - LEG_MARGIN;
  const rho = Math.min(want, (L * L - R * R) / (2 * R));
  if (!(rho >= MIN_ENTRY_RADIUS)) {
    return { rho: 0, phi: 0, t: R };
  }
  const t = tangentDistance(R, rho);
  return { rho, phi: Math.atan(rho / t), t };
}

/** The pieces a route follows through one roundabout: entry blend, ring, exit blend. */
function roundaboutPieces(r: Roundabout, prev: Vec2, next: Vec2): PathPiece[] {
  const [cx, cz] = r.center;
  const enter = Math.atan2(prev[1] - cz, prev[0] - cx);
  const exit = Math.atan2(next[1] - cz, next[0] - cx);

  // Sweep in the circulation direction only, in [0, 2π) — a route that leaves the
  // way it came in goes all the way round rather than standing still.
  let sweep = (((CIRCULATION * (exit - enter)) % TAU) + TAU) % TAU;
  if (sweep < 1e-6) {
    sweep = TAU;
  }

  const R = drivingRadius(r);
  const want = entryRadius(r);
  let bIn = blend(R, Math.hypot(prev[0] - cx, prev[1] - cz), want);
  let bOut = blend(R, Math.hypot(next[0] - cx, next[1] - cz), want);
  if (bIn.phi + bOut.phi + 0.05 > sweep) {
    // Two legs almost aligned: no room to weave in and out, take the plain arc.
    bIn = bOut = { rho: 0, phi: 0, t: R };
  }

  const at = (radius: number, a: number): Vec2 => [
    cx + radius * Math.cos(a),
    cz + radius * Math.sin(a),
  ];
  const pieces: PathPiece[] = [];

  // Entry: leave the leg at `t`, round the small circle (turning the opposite
  // way to the circulation), touch the ring `φ` past the leg's bearing.
  const aStart = enter + CIRCULATION * bIn.phi;
  if (bIn.rho > 0) {
    const centre = at(R + bIn.rho, aStart);
    const tangent = at(bIn.t, enter);
    const a0 = Math.atan2(tangent[1] - centre[1], tangent[0] - centre[0]);
    pieces.push(arcPiece(centre, bIn.rho, a0, a0 - CIRCULATION * (Math.PI / 2 - bIn.phi)));
  }

  // The ring itself, between the two touch points.
  const ringSweep = sweep - bIn.phi - bOut.phi;
  pieces.push(arcPiece(r.center, R, aStart, aStart + CIRCULATION * ringSweep));

  // Exit: mirror of the entry, from the touch point back onto the leg at `t`.
  if (bOut.rho > 0) {
    const aEnd = exit - CIRCULATION * bOut.phi;
    const centre = at(R + bOut.rho, aEnd);
    const touch = at(R, aEnd);
    const a0 = Math.atan2(touch[1] - centre[1], touch[0] - centre[0]);
    pieces.push(arcPiece(centre, bOut.rho, a0, a0 - CIRCULATION * (Math.PI / 2 - bOut.phi)));
  }
  return pieces;
}

/**
 * Drops the route points a roundabout's tarmac swallows. They are under the
 * island — nothing drives there — and the arc that replaces the junction needs
 * its neighbours far enough out to leave the ring tangentially. A roundabout
 * centre is never dropped (it is the junction itself), nor the two ends of the
 * route, nor any `pinned` point: a bridge deck end sits on the bridgehead
 * roundabout's outer edge, well inside `legReach`, and dropping it would leave
 * the crossing with no span to arch over — a flat bridge through the water.
 */
function trimIntoRoundabouts(points: Vec2[], roundabouts: Roundabout[], pinned: Vec2[]): Vec2[] {
  const centres = new Set(roundabouts.map((r) => vecKey(r.center)));
  for (const p of pinned) {
    centres.add(vecKey(p));
  }
  return points.filter((p, i) => {
    if (i === 0 || i === points.length - 1 || centres.has(vecKey(p))) {
      return true;
    }
    return !roundabouts.some(
      (r) => Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) < legReach(r) - 1e-6,
    );
  });
}

export function driveAroundRoundabouts(
  points: Vec2[],
  roundabouts: Roundabout[],
  pinned: Vec2[] = [],
): Vec2[] {
  if (points.length < 3 || roundabouts.length === 0) {
    return points;
  }

  const byCorner = new Map(roundabouts.map((r) => [vecKey(r.center), r]));
  const trimmed = trimIntoRoundabouts(points, roundabouts, pinned);
  if (trimmed.length < 3) {
    return points;
  }

  const out: Vec2[] = [trimmed[0]!];
  for (let i = 1; i < trimmed.length - 1; i++) {
    const p = trimmed[i]!;
    const r = byCorner.get(vecKey(p));
    if (!r) {
      out.push(p);
      continue;
    }
    out.push(
      ...samplePath(roundaboutPieces(r, trimmed[i - 1]!, trimmed[i + 1]!), ARC_CHORD, MAX_TURN),
    );
  }
  out.push(trimmed[trimmed.length - 1]!);
  return out;
}
