import { fnv1a, mulberry32 } from "../lib/random";
import { PITCH } from "./constants";
import { distToPolygon, pointInPolygon } from "./geometry";
import type { GroupZone, RoadNetwork, Vec2 } from "./types";

/**
 * A gently bent lattice: one smooth, seeded displacement field per city that every
 * layout point goes through — buildings, street vertices, roundabout centres,
 * driveways, routes, zones. The same input point always lands on the same output,
 * so the exact-equality road invariant survives. The field fades to exactly zero
 * on the ring and is zero outside it: ring vertices, bridgeheads, the harbour and
 * the shore never move. Streets are densified first so they bend instead of
 * staying straight chords between warped corners.
 */

/** Peak displacement of one wave. Two waves per axis: at most twice this. */
const AMPLITUDE = 0.55;
/** Wavelengths of the bends, in world units: several blocks per wave. */
const WAVE_MIN = PITCH * 4.5;
const WAVE_MAX = PITCH * 7;
/** Distance inside the ring over which the bend fades in. */
const FADE = PITCH * 1.5;
/** Densify step along an axis: every point of the `k · STEP` lattice on a street becomes a vertex. */
const STEP = PITCH / 4;

interface Wave {
  k: Vec2;
  phase: number;
  amp: number;
}

export interface CityWarp {
  apply(p: Vec2): Vec2;
  /** Rotation (radians, counter-clockwise in x→z) the field gives the lattice's x axis at `p`. */
  angleAt(p: Vec2): number;
}

export const IDENTITY_WARP: CityWarp = { apply: (p) => p, angleAt: () => 0 };

function waves(rand: () => number): Wave[] {
  return [0, 1].map(() => {
    const len = WAVE_MIN + rand() * (WAVE_MAX - WAVE_MIN);
    const a = rand() * Math.PI * 2;
    const m = (Math.PI * 2) / len;
    return { k: [Math.cos(a) * m, Math.sin(a) * m], phase: rand() * Math.PI * 2, amp: AMPLITUDE };
  });
}

/** The city's warp; identity when the ring is degenerate. */
export function cityWarp(cityId: string, ring: Vec2[]): CityWarp {
  if (ring.length < 3) {
    return IDENTITY_WARP;
  }
  const rand = mulberry32(fnv1a(`warp:${cityId}`));
  const wx = waves(rand);
  const wz = waves(rand);
  const field = (ws: Wave[], p: Vec2) =>
    ws.reduce((s, w) => s + w.amp * Math.sin(w.k[0] * p[0] + w.k[1] * p[1] + w.phase), 0);
  const fade = (p: Vec2): number => {
    if (!pointInPolygon(p, ring)) {
      return 0;
    }
    const t = Math.min(1, distToPolygon(p, ring) / FADE);
    return t * t * (3 - 2 * t);
  };
  const apply = (p: Vec2): Vec2 => {
    const f = fade(p);
    if (f === 0) {
      return p;
    }
    return [p[0] + f * field(wx, p), p[1] + f * field(wz, p)];
  };
  const angleAt = (p: Vec2): number => {
    const h = 0.05;
    const a = apply([p[0] - h, p[1]]);
    const b = apply([p[0] + h, p[1]]);
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  return { apply, angleAt };
}

/**
 * Inserts every `k · STEP` point strictly between two vertices on the same axis.
 * Same endpoints, same insertions: a route and the street under it densify alike.
 */
export function densify(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    out.push(a);
    const b = points[i + 1];
    if (!b) {
      break;
    }
    if (a[1] !== b[1] && a[0] !== b[0]) {
      continue;
    }
    const axis = a[1] === b[1] ? 0 : 1;
    const from = a[axis]!;
    const to = b[axis]!;
    const dir = Math.sign(to - from);
    let k = dir > 0 ? Math.floor(from / STEP) + 1 : Math.ceil(from / STEP) - 1;
    for (; dir * (k * STEP - to) < 0; k += dir) {
      const v = k * STEP;
      out.push(axis === 0 ? [v, a[1]] : [a[0], v]);
    }
  }
  return out;
}

/** Bends a city's roads; ring segments stay exactly as drawn. */
export function warpRoads(roads: RoadNetwork, warp: CityWarp): RoadNetwork {
  const line = (pts: Vec2[]) => densify(pts).map(warp.apply);
  // The first and last legs are driveways (centre → mouth): straight, like the driveway itself.
  const routeLine = (pts: Vec2[]) =>
    pts.length < 4
      ? pts.map(warp.apply)
      : [warp.apply(pts[0]!), ...line(pts.slice(1, -1)), warp.apply(pts.at(-1)!)];
  return {
    segments: roads.segments.map((s) => (s.ring ? s : { ...s, points: line(s.points) })),
    roundabouts: roads.roundabouts.map((r) => ({ ...r, center: warp.apply(r.center) })),
    driveways: roads.driveways.map((d) => ({
      ...d,
      mouth: warp.apply(d.mouth),
      door: warp.apply(d.door),
    })),
    ring: roads.ring,
    routes: new Map(
      [...roads.routes].map(([key, route]) => [key, { ...route, points: routeLine(route.points) }]),
    ),
  };
}

export function warpZone(zone: GroupZone, warp: CityWarp): GroupZone {
  return { ...zone, outline: zone.outline.map(warp.apply), center: warp.apply(zone.center) };
}
