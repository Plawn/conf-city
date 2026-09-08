import type { PositionedNode } from "../domain/types";
import { RING_CLEARANCE, RING_PADDING } from "./constants";
import { roundedOffset, segSegIntersect } from "./geometry";
import { footprintHull } from "./outline";
import type { Vec2 } from "./types";

/**
 * The ring road: one avenue looping around every island at a constant distance
 * from the built-up area, the way a European périphérique hugs its town. It is
 * what a building with no link of its own connects to, and where every bridge
 * lands.
 *
 * The ring is a closed polygon (last vertex ≠ first) that gets **mutated** as
 * things attach to it: a bridgehead or a driveway mouth is inserted as a
 * vertex of the loop (`attachRing`), so that the same `Vec2` ends up in the
 * ring, in the route that reaches it and — for a bridgehead — in the
 * roundabout and the bridge. Everything downstream matches those by exact
 * coordinate equality, which only holds if the value is shared, never
 * recomputed.
 */

/** Below this distance the hit reuses the nearby vertex (moved onto the hit) rather than adding a micro-step. */
const ATTACH_SNAP = 0.3;
const EPS = 1e-9;

export interface RingHit {
  point: Vec2;
  /** Index of the ring edge `[edge, edge + 1]` the point lies on. */
  edge: number;
}

/**
 * The ring around `nodes`, plus the polygon lattice corners must lie in to be
 * used by streets (`inner`): the same offset, `RING_CLEARANCE` closer to the
 * buildings, so nothing routed on the lattice ever runs into the ring's tarmac.
 */
export function buildRing(nodes: PositionedNode[]): { ring: Vec2[]; inner: Vec2[] } {
  const hull = footprintHull(nodes);
  return {
    ring: roundedOffset(hull, RING_PADDING),
    inner: roundedOffset(hull, RING_PADDING - RING_CLEARANCE),
  };
}

/**
 * Where a ray from `from` along `dir` first crosses the ring — for a point
 * inside, the exit. `null` when the ray misses (or the ring is degenerate).
 */
export function ringHit(from: Vec2, dir: Vec2, ring: Vec2[], reach = 1e4): RingHit | null {
  const n = ring.length;
  if (n < 2) {
    return null;
  }
  const len = Math.hypot(dir[0], dir[1]);
  if (len < EPS) {
    return null;
  }
  const to: Vec2 = [from[0] + (dir[0] / len) * reach, from[1] + (dir[1] / len) * reach];
  let best: RingHit | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const p = segSegIntersect(from, to, ring[i]!, ring[(i + 1) % n]!);
    if (!p) {
      continue;
    }
    const d = Math.hypot(p[0] - from[0], p[1] - from[1]);
    if (d < bestDist) {
      bestDist = d;
      best = { point: p, edge: i };
    }
  }
  return best;
}

/**
 * Makes `hit` a vertex of the ring and returns the `Vec2` now in the loop. A
 * vertex closer than `ATTACH_SNAP` is moved onto the hit instead of leaving a
 * micro-step in the polyline — unless it is `pinned` (already an attach point
 * someone else holds a reference to), in which case the step is accepted.
 */
export function attachRing(ring: Vec2[], hit: RingHit, pinned?: ReadonlySet<Vec2>): Vec2 {
  const n = ring.length;
  const point: Vec2 = [hit.point[0], hit.point[1]];
  const i = hit.edge;
  const j = (i + 1) % n;
  const a = ring[i]!;
  const b = ring[j]!;
  const da = Math.hypot(a[0] - point[0], a[1] - point[1]);
  const db = Math.hypot(b[0] - point[0], b[1] - point[1]);
  const near = da <= db ? { index: i, vertex: a, dist: da } : { index: j, vertex: b, dist: db };
  if (near.dist < ATTACH_SNAP) {
    if (pinned?.has(near.vertex)) {
      return near.vertex;
    }
    ring[near.index] = point;
    return point;
  }
  ring.splice(i + 1, 0, point);
  return point;
}
