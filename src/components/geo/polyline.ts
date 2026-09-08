import type { Vec2 } from "../../layout/types";

/**
 * Polyline arithmetic shared by the road renderer and the traffic: arc length,
 * cutting by distance, lateral offset and corner rounding. Everything is 2D on
 * the ground plane; the callers add the Y.
 *
 * "Right" throughout is the perpendicular `buildRibbon` calls `v = 0`:
 * `(dz, -dx)` for a direction `(dx, dz)`. It is not a promise about which way
 * a driver looks, only the side the whole rendering agrees on.
 */

const EPS = 1e-9;

export function arcLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/** Point and unit direction at arc length `t` (clamped to the polyline). */
export function pointAt(points: Vec2[], t: number): { point: Vec2; dir: Vec2 } {
  const first = points[0];
  if (!first) {
    return { point: [0, 0], dir: [1, 0] };
  }
  if (points.length === 1) {
    return { point: [first[0], first[1]], dir: [1, 0] };
  }
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < EPS) {
      continue;
    }
    const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    if (t <= walked + len || i + 2 === points.length) {
      const local = Math.max(0, Math.min(len, t - walked));
      return { point: [a[0] + dir[0] * local, a[1] + dir[1] * local], dir };
    }
    walked += len;
  }
  const last = points[points.length - 1]!;
  return { point: [last[0], last[1]], dir: [1, 0] };
}

/**
 * The part of the polyline between arc lengths `t0` and `t1`: the vertices in
 * between plus the two interpolated ends. Empty when nothing is left.
 */
export function subPolyline(points: Vec2[], t0: number, t1: number): Vec2[] {
  const total = arcLength(points);
  const from = Math.max(0, t0);
  const to = Math.min(total, t1);
  if (to - from < EPS) {
    return [];
  }
  const out: Vec2[] = [pointAt(points, from).point];
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    walked += len;
    if (walked > from + EPS && walked < to - EPS) {
      out.push([b[0], b[1]]);
    }
  }
  out.push(pointAt(points, to).point);
  return out;
}

/** The polyline with `fromStart` cut off its start and `fromEnd` off its end. */
export function cutPolyline(points: Vec2[], fromStart: number, fromEnd: number): Vec2[] {
  return subPolyline(points, fromStart, arcLength(points) - fromEnd);
}

/** Where `p` projects on the polyline: arc length, distance, and which side (`+1` = right). */
export function projectOnPolyline(
  points: Vec2[],
  p: Vec2,
): { t: number; dist: number; side: number } {
  let best = { t: 0, dist: Infinity, side: 1 };
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    if (len2 < EPS) {
      continue;
    }
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
    const qx = a[0] + dx * u;
    const qz = a[1] + dz * u;
    const dist = Math.hypot(p[0] - qx, p[1] - qz);
    if (dist < best.dist) {
      const cross = dx * (p[1] - a[1]) - dz * (p[0] - a[0]);
      // Right is (dz, -dx): a point there has a negative cross product.
      best = { t: walked + Math.sqrt(len2) * u, dist, side: cross < 0 ? 1 : -1 };
    }
    walked += Math.sqrt(len2);
  }
  return best;
}

/**
 * The polyline shifted `d` to the right (negative: left). Interior vertices get
 * the mitre of the two adjacent offsets, capped at twice the offset so a sharp
 * bend does not spike.
 */
export function offsetPolyline(points: Vec2[], d: number): Vec2[] {
  const path = dedupe(points);
  const n = path.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [[path[0]![0], path[0]![1]]];
  }
  const dirs: Vec2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    dirs.push([(b[0] - a[0]) / len, (b[1] - a[1]) / len]);
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    const before = dirs[Math.max(0, i - 1)]!;
    const after = dirs[Math.min(dirs.length - 1, i)]!;
    let nx = before[1] + after[1];
    let nz = -before[0] - after[0];
    const len = Math.hypot(nx, nz);
    if (len < EPS) {
      // A hairpin: fall back to the perpendicular of the incoming step.
      nx = before[1];
      nz = -before[0];
    } else {
      // Mitre length: 1 / cos(half angle), capped.
      const cos = (nx * before[1] - nz * before[0]) / len;
      const scale = 1 / Math.max(0.5, cos);
      nx = (nx / len) * scale;
      nz = (nz / len) * scale;
    }
    out.push([p[0] + nx * d, p[1] + nz * d]);
  }
  return out;
}

/**
 * Points of a circular arc from angle `a0` to `a1` (signed sweep), both ends
 * included. `step` bounds the chord, `maxTurn` the change of heading between
 * two points — on a small radius only the second one bites, and it is the one
 * that decides whether a vehicle's yaw sweeps or jumps.
 */
export function arcPoints(
  centre: Vec2,
  radius: number,
  a0: number,
  a1: number,
  step = 0.35,
  maxTurn = Infinity,
): Vec2[] {
  const sweep = a1 - a0;
  const steps = Math.max(
    1,
    Math.ceil((Math.abs(sweep) * radius) / step),
    Math.ceil(Math.abs(sweep) / maxTurn),
  );
  const out: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (sweep * k) / steps;
    out.push([centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)]);
  }
  return out;
}

/**
 * Replaces the interior vertices `keep` accepts by a tangent arc of at most
 * `radius`, shrunk so two arcs on one edge never overlap (each takes at most
 * half the edge). Vertices `keep` rejects, and nearly straight ones, stay.
 */
export function roundCorners(
  points: Vec2[],
  radius: number,
  step = 0.35,
  keep: (p: Vec2, index: number) => boolean = () => true,
  maxTurn = Infinity,
): Vec2[] {
  return roundCornersTagged(points, radius, step, keep, maxTurn).points;
}

/**
 * Reopens a closed ring at the *middle of an edge* rather than on a vertex,
 * starting from `start`: `[m, v_start, …, v_start-1, m]`.
 *
 * A loop closed by repeating its first vertex leaves that vertex on the two
 * ends of the sequence, where `roundCorners` never looks — so the one corner a
 * driver takes every lap was the only sharp one left, a 45° flick on an
 * octagonal ring. Cutting mid-edge instead makes every real vertex interior and
 * leaves the seam itself collinear with its neighbours, so the join is smooth
 * by construction rather than by a special case.
 */
export function closedSeam(ring: Vec2[], start: number): Vec2[] {
  const n = ring.length;
  if (n < 3) {
    return [...ring];
  }
  const seq: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    seq.push(ring[(start + k) % n]!);
  }
  const first = seq[0]!;
  const last = seq[n - 1]!;
  const mid: Vec2 = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
  return [mid, ...seq, mid];
}

/**
 * `roundCorners`, plus for every output point the index of the input vertex it
 * stands for — an arc's points all map to the vertex they replaced. That is
 * what lets a caller carry per-segment data (lane offsets) through the rounding.
 */
export function roundCornersTagged(
  points: Vec2[],
  radius: number,
  step = 0.35,
  keep: (p: Vec2, index: number) => boolean = () => true,
  maxTurn = Infinity,
): { points: Vec2[]; origin: number[] } {
  const { path, index } = dedupeTagged(points);
  const n = path.length;
  const out: Vec2[] = [];
  const origin: number[] = [];
  const emit = (p: Vec2, from: number) => {
    out.push(p);
    origin.push(from);
  };
  if (n === 0) {
    return { points: out, origin };
  }
  emit(path[0]!, index[0]!);
  for (let i = 1; i + 1 < n; i++) {
    const p = path[i]!;
    const src = index[i]!;
    if (!keep(p, src)) {
      emit(p, src);
      continue;
    }
    const prev = path[i - 1]!;
    const next = path[i + 1]!;
    const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const l2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const u1: Vec2 = [(p[0] - prev[0]) / l1, (p[1] - prev[1]) / l1];
    const u2: Vec2 = [(next[0] - p[0]) / l2, (next[1] - p[1]) / l2];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const turn = Math.acos(dot);
    if (turn < 0.02 || Math.abs(cross) < EPS) {
      emit(p, src);
      continue;
    }
    const tan = Math.tan(turn / 2);
    const r = Math.min(radius, Math.min(l1, l2) / 2 / tan);
    const d = r * tan;
    const t1: Vec2 = [p[0] - u1[0] * d, p[1] - u1[1] * d];
    // The centre is `r` to the inside of the turn from the first tangent point;
    // the arc then ends on the second tangent point by construction.
    const side = cross > 0 ? 1 : -1;
    const c: Vec2 = [t1[0] - u1[1] * r * side, t1[1] + u1[0] * r * side];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a1 = a0 + turn * side;
    for (const q of arcPoints(c, r, a0, a1, step, maxTurn)) {
      emit(q, src);
    }
  }
  if (n > 1) {
    emit(path[n - 1]!, index[n - 1]!);
  }
  return { points: out, origin };
}

function dedupeTagged(points: Vec2[]): { path: Vec2[]; index: number[] } {
  const path: Vec2[] = [];
  const index: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const last = path[path.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) {
      continue;
    }
    path.push(p);
    index.push(i);
  }
  return { path, index };
}

function dedupe(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) {
      continue;
    }
    out.push(p);
  }
  return out;
}
