import { EPS } from "../lib/math";
import type { CityBounds } from "./bounds";
import type { Vec2 } from "./types";

/**
 * 2D helpers on the ground plane (`[x, z]`). Pure, allocation-light, and free of
 * any Three.js dependency — the layout must stay renderer-agnostic.
 *
 * Polygons are closed implicitly (last point joins the first) and, once out of
 * `convexHull`, wound counter-clockwise in the `(x, z)` plane, which is what
 * `inflateConvex` relies on to know which side is "outside".
 */

/** `"x,z"` key of a point — the exact-equality key roads match on; never round first. */
export function vecKey(p: Vec2): string {
  return `${p[0]},${p[1]}`;
}

/** `"i,j"` key of a lattice cell — `layoutCity` and the harbour share it. */
export function cellKey(cell: [number, number]): string {
  return vecKey(cell);
}

/** Shortest distance from `p` to the segment `a → b` (a zero-length one is the point `a`). */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/** Shortest distance from `p` to an open polyline; `Infinity` below two points. */
export function distToPolyline(p: Vec2, points: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, distToSegment(p, points[i - 1]!, points[i]!));
  }
  return best;
}

/** Shortest distance from `p` to the boundary of the closed `ring` (not to its interior). */
export function distToPolygon(p: Vec2, ring: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, distToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!));
  }
  return best;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * True rounded offset of a convex CCW polygon: every edge is pushed `d` outwards
 * and every vertex becomes an arc of radius `d`, sampled about every `step`
 * world units. Unlike `chaikin(inflateConvex(…))` the result stays exactly `d`
 * away from the source everywhere, which is what lets the ring road and the
 * shore run parallel, and what keeps lattice corners a known distance from
 * the ring. One point gives a circle, two give a stadium.
 */
export function roundedOffset(poly: Vec2[], d: number, step = 1.2): Vec2[] {
  const n = poly.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    const [cx, cz] = poly[0]!;
    const sides = Math.max(8, Math.ceil((2 * Math.PI * d) / step));
    const out: Vec2[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      out.push([cx + Math.cos(a) * d, cz + Math.sin(a) * d]);
    }
    return out;
  }
  // Outward normal angle of each edge i → i+1 (a 2-gon has two opposite edges).
  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    angles.push(Math.atan2(-(q[0] - p[0]), q[1] - p[1]));
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const from = angles[(i + n - 1) % n]!;
    let sweep = angles[i]! - from;
    while (sweep < -EPS) {
      sweep += Math.PI * 2;
    }
    while (sweep >= Math.PI * 2 - EPS) {
      sweep -= Math.PI * 2;
    }
    const steps = Math.max(1, Math.ceil((sweep * d) / step));
    for (let k = 0; k <= steps; k++) {
      const a = from + (sweep * k) / steps;
      const x = p[0] + Math.cos(a) * d;
      const z = p[1] + Math.sin(a) * d;
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - x) < EPS && Math.abs(last[1] - z) < EPS) {
        continue;
      }
      out.push([x, z]);
    }
  }
  const first = out[0]!;
  const last = out[out.length - 1]!;
  if (out.length > 1 && Math.abs(last[0] - first[0]) < EPS && Math.abs(last[1] - first[1]) < EPS) {
    out.pop();
  }
  return out;
}

/** Signed area ×2; positive when the polygon is counter-clockwise. */
export function signedArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s;
}

/** Andrew's monotone chain. Returns a CCW hull without duplicated endpoints. */
export function convexHull(points: Vec2[]): Vec2[] {
  if (points.length < 3) {
    return points.map((p) => [p[0], p[1]] as Vec2);
  }
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper].map((p) => [p[0], p[1]] as Vec2);
  if (hull.length >= 3 && signedArea(hull) < 0) {
    hull.reverse();
  }
  return hull;
}

/**
 * Miter offset of a convex polygon by `d` outwards. Each vertex moves along the
 * bisector of its two edge normals, scaled so both offset edges are met; the
 * `cos` floor keeps needle-sharp corners from shooting off to infinity.
 */
export function inflateConvex(poly: Vec2[], d: number): Vec2[] {
  const n = poly.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [[poly[0]![0], poly[0]![1]]];
  }
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    // Outward normal of a CCW edge.
    normals.push([dz / len, -dx / len]);
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const nPrev = normals[(i - 1 + n) % n]!;
    const nCur = normals[i]!;
    let bx = nPrev[0] + nCur[0];
    let bz = nPrev[1] + nCur[1];
    const blen = Math.hypot(bx, bz);
    if (blen < EPS) {
      bx = nCur[0];
      bz = nCur[1];
    } else {
      bx /= blen;
      bz /= blen;
    }
    const cos = Math.max(0.25, bx * nCur[0] + bz * nCur[1]);
    const p = poly[i]!;
    out.push([p[0] + (bx * d) / cos, p[1] + (bz * d) / cos]);
  }
  return out;
}

/** Chaikin corner cutting on a closed polygon: rounds the shore without a spline. */
export function chaikin(poly: Vec2[], iterations = 1): Vec2[] {
  let cur = poly;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) {
      return cur;
    }
    const next: Vec2[] = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i]!;
      const q = cur[(i + 1) % cur.length]!;
      next.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      next.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    cur = next;
  }
  return cur;
}

/** AABB of a point set, in the `CityBounds` shape the camera helpers consume. */
export function polygonBounds(poly: Vec2[], padding = 0): CityBounds | null {
  if (poly.length === 0) {
    return null;
  }
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]);
    maxZ = Math.max(maxZ, p[1]);
  }
  return {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    width: maxX - minX + padding * 2,
    height: maxZ - minZ + padding * 2,
  };
}

/** Arithmetic mean of the points (not the area centroid — good enough as an anchor). */
export function centroid(points: Vec2[]): Vec2 {
  if (points.length === 0) {
    return [0, 0];
  }
  let x = 0,
    z = 0;
  for (const p of points) {
    x += p[0];
    z += p[1];
  }
  return [x / points.length, z / points.length];
}

/** Intersection of segments [a,b] and [c,d], or null when they don't properly cross. */
export function segSegIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const rx = b[0] - a[0],
    rz = b[1] - a[1];
  const sx = d[0] - c[0],
    sz = d[1] - c[1];
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < EPS) {
    return null;
  }
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null;
  }
  return [a[0] + t * rx, a[1] + t * rz];
}

/** Ray-casting point-in-polygon test; boundary points count as inside enough. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Where the ray `a → b` leaves `poly` (a is expected inside): the crossing
 * closest to `a`. Returns null when the segment never meets the boundary.
 */
export function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: Vec2[]): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const hit = segSegIntersect(a, b, p, q);
    if (!hit) {
      continue;
    }
    const dist = Math.hypot(hit[0] - a[0], hit[1] - a[1]);
    if (dist < bestDist) {
      bestDist = dist;
      best = hit;
    }
  }
  return best;
}
