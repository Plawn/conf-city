import type { Vec2 } from "../layout/types";
import { EPS } from "../lib/math";

/**
 * A drivable path as *primitives* — straight segments and circular arcs — kept
 * exact until the last moment.
 *
 * A polyline cannot be offset: shifting its vertices sideways by a mitre folds
 * the path over itself as soon as the local radius drops below the offset, and
 * that fold is what made a vehicle in the outer lane of a boulevard roundabout
 * appear to reverse. An arc *can*: its exact offset is a concentric arc, and a
 * line's is a parallel line. So the geometry is built as pieces, the lane
 * offsets are checked against the radius they ride on, and only then is the
 * whole thing sampled — at a bounded change of heading rather than a bounded
 * chord, which is what the eye and the simulation actually care about.
 *
 * "Right" here is the driver's right, `(-dz, dx)`, the side `sim/traffic/frame.ts`
 * keeps to — *not* the `(dz, -dx)` of `offsetPolyline`.
 */

/**
 * No driven lane may curve tighter than this. A car is 0.55 long and 0.25 from
 * the centreline of a street: below ≈ 0.35 the offset path starts to cusp, and
 * at 0 it turns inside out.
 */
export const MIN_DRIVEN_RADIUS = 0.8;

/**
 * How fast a lane offset may move sideways, per unit of arc length: 0.06, so a
 * boulevard's outer lane takes some 7 of road to merge onto a deck's single
 * lane. A lane that has to give up part of its offset — for a tight corner, a
 * narrower class — starts giving it up metres earlier, like a real merge. A
 * step here is a kink there, whatever smoothing comes afterwards, and the rate
 * is the kink's angle: 0.12 left 6.7° in the driven path, 0.06 leaves 5.4°.
 */
export const LANE_SLEW = 0.06;

/** Default bound on the heading change between two sampled points: 4°. */
export const MAX_TURN = Math.PI / 45;

export type PathPiece =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "arc"; centre: Vec2; radius: number; a0: number; a1: number };

export function linePiece(a: Vec2, b: Vec2): PathPiece {
  return { kind: "line", a, b };
}

export function arcPiece(centre: Vec2, radius: number, a0: number, a1: number): PathPiece {
  return { kind: "arc", centre, radius, a0, a1 };
}

const on = (centre: Vec2, radius: number, a: number): Vec2 => [
  centre[0] + radius * Math.cos(a),
  centre[1] + radius * Math.sin(a),
];

/**
 * The radius a driver offset `d` to their right actually rides on. A left turn
 * (the offset on the outside) widens it, a right turn tightens it; a straight
 * piece is infinite either way.
 */
export function drivenRadius(p: PathPiece, d: number): number {
  if (p.kind === "line") {
    return Infinity;
  }
  // Increasing angle turns left, so the driver's right is the inside.
  return p.a1 > p.a0 ? p.radius - d : p.radius + d;
}

/** `d` shrunk, if need be, so the offset path still curves at `MIN_DRIVEN_RADIUS`. */
export function cappedOffset(p: PathPiece, d: number): number {
  if (p.kind === "line" || p.a1 <= p.a0) {
    return d;
  }
  return Math.min(d, Math.max(0, p.radius - MIN_DRIVEN_RADIUS));
}

/** The exact offset of a piece, `d` to the driver's right, never inside out. */
export function offsetPiece(p: PathPiece, d: number): PathPiece {
  if (p.kind === "line") {
    const dx = p.b[0] - p.a[0];
    const dz = p.b[1] - p.a[1];
    const len = Math.hypot(dx, dz);
    if (len < EPS) {
      return p;
    }
    const nx = (-dz / len) * d;
    const nz = (dx / len) * d;
    return linePiece([p.a[0] + nx, p.a[1] + nz], [p.b[0] + nx, p.b[1] + nz]);
  }
  const radius = drivenRadius(p, cappedOffset(p, d));
  return arcPiece(p.centre, Math.max(MIN_DRIVEN_RADIUS, radius), p.a0, p.a1);
}

/**
 * Samples a chain of pieces into a polyline. An arc is cut so that neither the
 * chord (`step`) nor the heading change (`maxTurn`) exceeds its bound — the
 * second is what removes the visible staircase, since a bounded chord on a
 * small blend circle is still a 24° kink.
 */
export function samplePath(pieces: PathPiece[], step = 0.3, maxTurn = MAX_TURN): Vec2[] {
  const out: Vec2[] = [];
  const push = (p: Vec2) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) {
      out.push(p);
    }
  };
  for (const piece of pieces) {
    if (piece.kind === "line") {
      push(piece.a);
      push(piece.b);
      continue;
    }
    const sweep = piece.a1 - piece.a0;
    const steps = Math.max(
      1,
      Math.ceil((Math.abs(sweep) * piece.radius) / step),
      Math.ceil(Math.abs(sweep) / maxTurn),
    );
    for (let k = 0; k <= steps; k++) {
      push(on(piece.centre, piece.radius, piece.a0 + (sweep * k) / steps));
    }
  }
  return out;
}

/**
 * The turn radius at each interior vertex of a sampled polyline, signed: `+r`
 * where the path bends to the driver's right (the offset rides inside and the
 * radius shrinks), `+Infinity` where it is straight or bends left.
 */
function rightTurnRadius(points: Vec2[], i: number): number {
  const prev = points[i - 1];
  const p = points[i];
  const next = points[i + 1];
  if (!prev || !p || !next) {
    return Infinity;
  }
  const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
  const l2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
  if (l1 < EPS || l2 < EPS) {
    return Infinity;
  }
  const u1: Vec2 = [(p[0] - prev[0]) / l1, (p[1] - prev[1]) / l1];
  const u2: Vec2 = [(next[0] - p[0]) / l2, (next[1] - p[1]) / l2];
  const cross = u1[0] * u2[1] - u1[1] * u2[0];
  if (cross <= EPS) {
    return Infinity; // straight, or turning away from the offset
  }
  const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const turn = Math.acos(dot);
  return Math.max(EPS, (l1 + l2) / 2 / (2 * Math.sin(turn / 2)));
}

/**
 * Caps every lane offset of an already-sampled path to what its local curvature
 * can carry. This is the last line of defence behind `offsetPiece`: whatever
 * produced the polyline — a roundabout blend, a lattice bend, a bridge ramp —
 * no lane can be asked to ride a radius it would fold over.
 */
/**
 * The largest `LANE_SLEW`-Lipschitz function that stays under `values`:
 * `f(s) = min_j (values[j] + LANE_SLEW · distance(s, j))`. Two sweeps compute it
 * exactly (four on a loop, so a cut just after the seam still reaches back
 * before it).
 *
 * This is what turns a *step* in lane offset — a class change, a corner too
 * tight for the outer lane — into a merge that starts metres earlier. A step of
 * 0.45 spread over 0.6 of road is a 37° kink in the driven path whatever
 * smoothing follows it; slewed at 0.12 it is under 7°, and the averaging in
 * `routeGeometry` rounds even that.
 */
export function slewLimit(values: number[], lengths: number[], loop = false): number[] {
  const n = values.length;
  const out = values.slice();
  const gap = (a: number, b: number) => ((lengths[a] ?? 0) + (lengths[b] ?? 0)) / 2;
  const relax = (from: number, to: number) => {
    const limit = out[from]! + LANE_SLEW * gap(from, to);
    if (out[to]! > limit) {
      out[to] = limit;
    }
  };
  for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
    for (let s = 1; s < n; s++) {
      relax(s - 1, s);
    }
    if (loop && n > 1) {
      relax(n - 1, 0);
    }
    for (let s = n - 2; s >= 0; s--) {
      relax(s + 1, s);
    }
    if (loop && n > 1) {
      relax(0, n - 1);
    }
  }
  return out;
}

export function capLaneOffsets(
  points: Vec2[],
  lanes: [number, number][],
  loop = false,
): [number, number][] {
  if (lanes.length === 0) {
    return lanes;
  }
  const vertex = points.map((_, i) => rightTurnRadius(points, i));
  const lengths = lanes.map((_, s) => {
    const a = points[s];
    const b = points[s + 1];
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
  });
  const capped = lanes.map((pair, s) => {
    const radius = Math.min(vertex[s] ?? Infinity, vertex[s + 1] ?? Infinity);
    if (!Number.isFinite(radius)) {
      return pair;
    }
    const max = Math.max(0, radius - MIN_DRIVEN_RADIUS);
    return [Math.min(pair[0], max), Math.min(pair[1], max)] as [number, number];
  });
  const inner = slewLimit(
    capped.map((p) => p[0]),
    lengths,
    loop,
  );
  const outer = slewLimit(
    capped.map((p) => p[1]),
    lengths,
    loop,
  );
  return capped.map((_, s) => [inner[s]!, outer[s]!] as [number, number]);
}
