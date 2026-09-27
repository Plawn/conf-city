import { arcLength } from "../../geo/polyline";
import { RING_ROUNDABOUT_CLEAR } from "../constants";
import { centroid } from "../geometry";
import type { CityNodesLayout } from "../layoutCity";
import { attachRing, buildRing, ringHit } from "../ringRoad";
import type { Vec2 } from "../types";
import { cellCentre, cornerPos, DIRECTIONS, type Grid, makeGrid, walkOut } from "./lattice";

/** A bridgehead a bit further up the ring is worth a slightly longer way to it. */
const DEEP_WEIGHT = 0.25;

/**
 * Where a bridge lands on this city's ring, and how streets get there.
 *
 * `corner` is the lattice corner the feeders are routed to; `path` runs from it
 * outwards, corner by corner, to the last one inside the ring, from which the
 * straight stub reaches `hit` — a vertex of the ring, and the roundabout's
 * centre. With no usable corner at all (a lone building) the bridge is served
 * by that building's own driveway instead: `corner` is null and `driveway`
 * names it.
 */
export interface Bridgehead {
  hit: Vec2;
  corner: [number, number] | null;
  path: [number, number][];
  driveway?: string;
}

export interface GateRequest {
  /** `linkKey` of the inter-city link — the route is stored under it. */
  key: string;
  nodeId: string;
  gate: Bridgehead;
}

/**
 * Plans the bridgehead of one inter-city pair on this city's ring, facing
 * `toward` (the other city), and attaches it to the ring. Candidates are the
 * usable corners with an axial way out in that general direction; the way out
 * must leave `RING_ROUNDABOUT_CLEAR` between the corner and the roundabout,
 * and the closest to where the straight line to the other city leaves the ring
 * wins. `pinned` holds the ring vertices already handed out, which must not move.
 */
export function planBridgehead(
  city: CityNodesLayout,
  grid: Grid,
  ring: Vec2[],
  toward: Vec2,
  pinned: Set<Vec2>,
): Bridgehead | null {
  if (ring.length < 3) {
    return null;
  }
  const centre = centroid(ring);
  const shore = ringHit(centre, toward, ring)?.point;
  if (!shore) {
    return null;
  }

  let best: {
    score: number;
    corner: [number, number];
    path: [number, number][];
    hit: ReturnType<typeof ringHit>;
  } | null = null;
  for (let cj = grid.loJ; cj <= grid.hiJ; cj++) {
    for (let ci = grid.loI; ci <= grid.hiI; ci++) {
      if (!grid.inGrid(ci, cj)) {
        continue;
      }
      for (const dir of DIRECTIONS) {
        if (dir[0] * toward[0] + dir[1] * toward[1] <= 0) {
          continue;
        }
        const path = walkOut([ci, cj], dir, grid);
        const last = path[path.length - 1]!;
        const hit = ringHit(cornerPos(last[0], last[1]), dir, ring);
        if (!hit) {
          continue;
        }
        const start = cornerPos(ci, cj);
        const deep = Math.hypot(hit.point[0] - start[0], hit.point[1] - start[1]);
        if (deep < RING_ROUNDABOUT_CLEAR) {
          continue;
        }
        const score =
          Math.hypot(hit.point[0] - shore[0], hit.point[1] - shore[1]) + DEEP_WEIGHT * deep;
        if (!best || score < best.score) {
          best = { score, corner: [ci, cj], path, hit };
        }
      }
    }
  }
  if (best) {
    const hit = attachRing(ring, best.hit!, pinned);
    pinned.add(hit);
    return { hit, corner: best.corner, path: best.path };
  }

  // No lattice to speak of: the building itself opens onto the ring.
  const ids = [...city.cells.keys()].sort();
  let lone: { score: number; id: string; hit: ReturnType<typeof ringHit> } | null = null;
  for (const id of ids) {
    const centreOf = cellCentre(city.cells.get(id)!);
    for (const dir of DIRECTIONS) {
      if (dir[0] * toward[0] + dir[1] * toward[1] <= 0) {
        continue;
      }
      const hit = ringHit(centreOf, dir, ring);
      if (!hit) {
        continue;
      }
      const score = Math.hypot(hit.point[0] - shore[0], hit.point[1] - shore[1]);
      if (!lone || score < lone.score) {
        lone = { score, id, hit };
      }
    }
  }
  if (!lone) {
    return null;
  }
  const hit = attachRing(ring, lone.hit!, pinned);
  pinned.add(hit);
  return { hit, corner: null, path: [], driveway: lone.id };
}

export function makeRing(city: CityNodesLayout): { ring: Vec2[]; grid: Grid } {
  const { ring, inner } = buildRing(city.nodes);
  return { ring, grid: makeGrid(city.cells, inner) };
}

/** The ring vertices from `a` to `b` (both included), the shorter way round. */
export function ringArc(ring: Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const ia = ring.indexOf(a);
  const ib = ring.indexOf(b);
  if (ia < 0 || ib < 0) {
    return [a, b];
  }
  if (ia === ib) {
    return [a];
  }
  const n = ring.length;
  const walk = (step: 1 | -1): Vec2[] => {
    const points: Vec2[] = [a];
    for (let i = ia; i !== ib; ) {
      const j = (i + step + n) % n;
      points.push(ring[j]!);
      i = j;
    }
    return points;
  };
  const cw = walk(1);
  const ccw = walk(-1);
  return arcLength(cw) <= arcLength(ccw) ? cw : ccw;
}
