import { LOT_MB } from "../domain/capacity";
import type { PositionedNode } from "../domain/types";
import { mulberry32 } from "../lib/random";
import { footprintRadius, ISLAND_PADDING, PITCH } from "./constants";
import {
  centroid,
  chaikin,
  convexHull,
  inflateConvex,
  roundedOffset,
  signedArea,
} from "./geometry";
import type { Vec2 } from "./types";

/**
 * Shore lines and neighbourhood slabs.
 *
 * The island is a true rounded offset of the hull of every footprint: the ring
 * road is the same offset at a smaller distance, so the shore runs parallel to
 * it all the way round. Neighbourhood slabs keep the cheaper look — hull
 * inflated then softened by two Chaikin passes — since nothing lines up with them.
 *
 * A zone of one or two buildings has no hull to speak of, so it falls back to a
 * regular 16-gon — still a slab, just a round one.
 *
 * The shore can then be roughened by the biome: seeded noise pushes the
 * coastline **outward only**, so everything laid out against the un-roughened
 * offset — the ring road, the bridgehead roundabouts ≈ 2 units inside it — is
 * still on dry land. Ruggedness 0 returns the exact rounded offset.
 */

const SMOOTHING_PASSES = 2;
const FALLBACK_SIDES = 16;

/** The four corners of each building's ground footprint. */
export function footprintCorners(nodes: PositionedNode[]): Vec2[] {
  const points: Vec2[] = [];
  for (const n of nodes) {
    const r = footprintRadius(n.type);
    const [x, , z] = n.position;
    points.push([x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]);
  }
  return points;
}

/** Closed CCW polygon around `points`, `padding` away from them. */
export function zoneOutline(points: Vec2[], padding: number): Vec2[] {
  if (points.length === 0) {
    return [];
  }
  const hull = convexHull(points);
  if (hull.length < 3) {
    return disc(centroid(points), radiusAround(centroid(points), points) + padding);
  }
  return chaikin(inflateConvex(hull, padding), SMOOTHING_PASSES);
}

/** The hull of every footprint — what both the shore and the ring road are offsets of. */
export function footprintHull(nodes: PositionedNode[]): Vec2[] {
  return convexHull(footprintCorners(nodes));
}

/** How the biome shapes the coast: the noise seed and its amplitude, 0..1. */
export interface ShoreShape {
  seed: number;
  ruggedness: number;
}

/** Largest outward push of the coast at ruggedness 1, world units. */
const ROUGHEN_AMPLITUDE = 2.2;
/** Vertex spacing the shore is resampled to before the noise — the noise cannot be finer than this. */
const ROUGHEN_STEP = 1.5;
/** Edge length of the capacity disc. */
const CAPACITY_STEP = 1.2;

/**
 * Radius of the land a machine's memory buys: `LOT_MB` per lattice lot, as a
 * disc, plus the same `ISLAND_PADDING` the buildings' shore gets.
 */
export function capacityRadius(capacityMb: number): number {
  return Math.sqrt(((capacityMb / LOT_MB) * PITCH * PITCH) / Math.PI) + ISLAND_PADDING;
}

export interface IslandShore {
  outline: Vec2[];
  /** Area the buildings need over the area the machine's memory buys; > 1 is overbuilt. */
  crowding?: number;
  /** Overbuilt only: the natural island inside `outline`; the rest is landfill over the water. */
  land?: Vec2[];
}

/**
 * The island's shore: the hull of every footprint, `ISLAND_PADDING` offshore,
 * grown to the machine's capacity disc when `capacityMb` is given (never
 * shrunk: the ring road stays on land), then roughened by `shape` when given.
 */
export function islandShore(
  nodes: PositionedNode[],
  shape?: ShoreShape,
  capacityMb?: number,
): IslandShore {
  const hull = nodes.length === 0 ? [] : footprintHull(nodes);
  const needed =
    nodes.length === 0 ? disc([0, 0], ISLAND_PADDING) : roundedOffset(hull, ISLAND_PADDING);
  const rough = (poly: Vec2[]): Vec2[] =>
    !shape || shape.ruggedness <= 0
      ? poly
      : roughen(poly, shape.seed, shape.ruggedness * ROUGHEN_AMPLITUDE);
  if (capacityMb == null || capacityMb <= 0) {
    return { outline: rough(needed) };
  }
  const r = capacityRadius(capacityMb);
  const crowding = Math.abs(signedArea(needed)) / 2 / (Math.PI * r * r);
  const sides = Math.max(FALLBACK_SIDES, Math.ceil((2 * Math.PI * r) / CAPACITY_STEP));
  const center = hull.length > 0 ? boxCentre(hull) : ([0, 0] as Vec2);
  const capacity = disc(center, r, sides);
  if (crowding <= 1) {
    return { outline: rough(convexHull([...needed, ...capacity])), crowding };
  }
  // Overbuilt: the memory's land stays natural, and the rest is built out over
  // the water — a straight-edged landfill hull around it, never roughened.
  const land = rough(capacity);
  return { outline: convexHull([...needed, ...land]), land, crowding };
}

export function islandOutline(nodes: PositionedNode[], shape?: ShoreShape): Vec2[] {
  return islandShore(nodes, shape).outline;
}

/**
 * Pushes every vertex of a closed CCW polygon along its outward normal by a
 * non-negative, seeded amount: two low harmonics along the perimeter for bays
 * and headlands, a small per-vertex grain, one Chaikin pass to take the edge
 * off. The result contains the input.
 */
export function roughen(poly: Vec2[], seed: number, amp: number): Vec2[] {
  if (poly.length < 3 || amp <= 0) {
    return poly;
  }
  const rand = mulberry32(seed);
  const phase1 = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  const pts = resample(poly, ROUGHEN_STEP);
  const n = pts.length;

  // Arc-length parameter of each vertex, 0..1 round the perimeter.
  const t: number[] = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    t[i] = s;
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const perimeter = s || 1;

  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    // Outward normal of a CCW polygon in (x, z): (dz, -dx), averaged over both edges.
    let nx = cur[1] - prev[1] + (next[1] - cur[1]);
    let nz = -(cur[0] - prev[0] + (next[0] - cur[0]));
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const u = (t[i]! / perimeter) * Math.PI * 2;
    const d =
      amp *
      (0.35 * (0.5 + 0.5 * Math.sin(3 * u + phase1)) +
        0.35 * (0.5 + 0.5 * Math.sin(5 * u + phase2)) +
        0.3 * rand());
    out[i] = [cur[0] + nx * d, cur[1] + nz * d];
  }
  return chaikin(out, 1);
}

/** Inserts vertices so no edge is longer than `step`; the original vertices are kept. */
function resample(poly: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const parts = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < parts; k++) {
      const f = k / parts;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
  }
  return out;
}

function radiusAround(center: Vec2, points: Vec2[]): number {
  let r = 0;
  for (const p of points) {
    r = Math.max(r, Math.hypot(p[0] - center[0], p[1] - center[1]));
  }
  return r;
}

function boxCentre(points: Vec2[]): Vec2 {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return [(minX + maxX) / 2, (minZ + maxZ) / 2];
}

function disc(center: Vec2, radius: number, sides = FALLBACK_SIDES): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    out.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
  }
  return out;
}
