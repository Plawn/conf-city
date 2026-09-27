import type { ResolvedLink } from "../../domain/types";
import { LATTICE_ROUNDABOUT_CLEAR, ROUNDABOUT_SPACING } from "../constants";
import { vecKey } from "../geometry";
import { linkKey, type RoadClass, type RoadRoute, type RoadSegment, type Vec2 } from "../types";
import { cornerPos } from "./lattice";

/** Routes on an edge from which it is drawn as an avenue / a boulevard. */
const AVENUE_FROM = 2;
const BOULEVARD_FROM = 3;

export function midpoint(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function dedupePoints(points: Vec2[]): Vec2[] {
  return points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1],
  );
}

export function classOf(uses: number): RoadClass {
  if (uses >= BOULEVARD_FROM) {
    return "boulevard";
  }
  if (uses >= AVENUE_FROM) {
    return "avenue";
  }
  return "street";
}

const CLASS_RANK: Record<RoadClass, number> = { street: 0, avenue: 1, boulevard: 2 };

/** The busier of two road classes. */
export function heavier(a: RoadClass, b: RoadClass): RoadClass {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

export function dedupeLinks(links: ResolvedLink[]): ResolvedLink[] {
  const byKey = new Map<string, ResolvedLink>();
  for (const l of links) {
    const key = linkKey(l);
    if (!byKey.has(key)) {
      byKey.set(key, l);
    }
  }
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

/**
 * Which lattice crossroads become roundabouts: corners where three or more
 * streets meet, busiest first, kept `ROUNDABOUT_SPACING` apart from each other
 * and from the bridgehead roundabouts already on the ring, and
 * `LATTICE_ROUNDABOUT_CLEAR` from the ring road itself.
 */
export function pickRoundabouts(
  cornerDirs: ReadonlyMap<string, Set<string>>,
  routes: ReadonlyMap<string, RoadRoute>,
  ringCentres: Vec2[],
  ring: Vec2[] = [],
): Set<string> {
  const traffic = new Map<string, number>();
  for (const route of routes.values()) {
    for (const [x, z] of route.points) {
      const key = vecKey([x, z]);
      traffic.set(key, (traffic.get(key) ?? 0) + 1);
    }
  }

  const candidates: { key: string; pos: Vec2; score: number }[] = [];
  for (const [key, dirs] of cornerDirs) {
    if (dirs.size < 3) {
      continue;
    }
    const [ci, cj] = key.split(",").map(Number) as [number, number];
    const pos = cornerPos(ci, cj);
    candidates.push({ key, pos, score: traffic.get(vecKey(pos)) ?? 0 });
  }
  candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const kept: Vec2[] = [...ringCentres];
  const out = new Set<string>();
  for (const c of candidates) {
    const crowded = kept.some(
      (k) => Math.hypot(k[0] - c.pos[0], k[1] - c.pos[1]) < ROUNDABOUT_SPACING,
    );
    if (crowded || distanceToLoop(c.pos, ring) < LATTICE_ROUNDABOUT_CLEAR) {
      continue;
    }
    kept.push(c.pos);
    out.add(c.key);
  }
  return out;
}

/** Distance from `p` to the closed polyline `loop` (Infinity when empty). */
export function distanceToLoop(p: Vec2, loop: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t));
  }
  return best;
}

/**
 * Lattice edges → straight segments: maximal axis-aligned runs of one class,
 * cut at every roundabout and at every corner where three or more directions
 * meet. A plain bend (two directions) is two segments sharing an end — the
 * renderer fuses those into one curve.
 */
export function mergeSegments(
  edgeUse: ReadonlyMap<string, number>,
  roundabouts: ReadonlySet<string>,
  cornerDirs: ReadonlyMap<string, Set<string>>,
): RoadSegment[] {
  const horizontal = new Map<number, [number, RoadClass][]>();
  const vertical = new Map<number, [number, RoadClass][]>();
  for (const [key, uses] of edgeUse) {
    const [ci, cj, di] = key.split(",").map(Number) as [number, number, number, number];
    const klass = classOf(uses);
    if (di === 1) {
      const list = horizontal.get(cj) ?? [];
      list.push([ci, klass]);
      horizontal.set(cj, list);
    } else {
      const list = vertical.get(ci) ?? [];
      list.push([cj, klass]);
      vertical.set(ci, list);
    }
  }
  const isCut = (ci: number, cj: number) => {
    const key = `${ci},${cj}`;
    return roundabouts.has(key) || (cornerDirs.get(key)?.size ?? 0) >= 3;
  };

  const segments: RoadSegment[] = [];
  const runs = (list: [number, RoadClass][], at: (index: number) => [number, number]) => {
    list.sort((a, b) => a[0] - b[0]);
    let start = list[0]!;
    let prev = list[0]!;
    for (let k = 1; k <= list.length; k++) {
      const cur = list[k];
      const continues =
        cur !== undefined && cur[0] === prev[0] + 1 && cur[1] === prev[1] && !isCut(...at(cur[0]));
      if (continues) {
        prev = cur;
        continue;
      }
      const [ai, aj] = at(start[0]);
      const [bi, bj] = at(prev[0] + 1);
      segments.push({ points: [cornerPos(ai, aj), cornerPos(bi, bj)], klass: start[1] });
      if (cur !== undefined) {
        start = cur;
        prev = cur;
      }
    }
  };
  for (const cj of [...horizontal.keys()].sort((a, b) => a - b)) {
    runs(horizontal.get(cj)!, (ci) => [ci, cj]);
  }
  for (const ci of [...vertical.keys()].sort((a, b) => a - b)) {
    runs(vertical.get(ci)!, (cj) => [ci, cj]);
  }
  return segments;
}

/**
 * The ring as avenue segments, cut at every vertex a road joins it by (`joins`,
 * `vecKey`s), and always in at least two pieces so no segment is ever a closed loop.
 */
export function ringSegments(ring: Vec2[], joins: ReadonlySet<string>): RoadSegment[] {
  const n = ring.length;
  if (n < 3) {
    return [];
  }
  let cuts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (joins.has(vecKey(ring[i]!))) {
      cuts.push(i);
    }
  }
  if (cuts.length === 0) {
    cuts = [0, Math.floor(n / 2)];
  } else if (cuts.length === 1) {
    cuts.push((cuts[0]! + Math.floor(n / 2)) % n);
  }
  cuts.sort((a, b) => a - b);

  const out: RoadSegment[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const a = cuts[k]!;
    const b = cuts[(k + 1) % cuts.length]!;
    const points: Vec2[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      points.push(ring[i]!);
      if (i === b) {
        break;
      }
    }
    if (points.length >= 2) {
      out.push({ points, klass: "avenue", ring: true });
    }
  }
  return out;
}
