import type { ResolvedLink } from "../../domain/types";
import { PITCH, RING_ROUNDABOUT_CLEAR } from "../constants";
import { segSegIntersect, vecKey } from "../geometry";
import { attachRing, ringHit } from "../ringRoad";
import { linkKey, type Vec2 } from "../types";
import { ringArc } from "./bridgehead";
import { type BuildState, doorTowards } from "./buildState";
import { cellCentre, cornerPos, DIRECTIONS, occupied } from "./lattice";
import { dedupePoints } from "./segments";

/** The ring as a street: segments a driveway to it must not cross, and each building's mouth. */
export interface RingStreet {
  blockers: [Vec2, Vec2][];
  mouths: Map<string, Vec2>;
}

/**
 * The ring as a street: what a building nothing else reaches opens onto, and
 * what carries a link between two buildings the lattice could not join.
 */
export function ringStreet(state: BuildState): RingStreet {
  const blockers: [Vec2, Vec2][] = [];
  for (const key of state.edgeUse.keys()) {
    const [ci, cj, di, dj] = key.split(",").map(Number) as [number, number, number, number];
    blockers.push([cornerPos(ci, cj), cornerPos(ci + di, cj + dj)]);
  }
  for (const s of state.stubs.values()) {
    blockers.push([cornerPos(s.corner[0], s.corner[1]), s.hit]);
  }
  return { blockers, mouths: new Map() };
}

/**
 * One driveway per building onto the ring: the shortest axial way out that
 * crosses nothing, preferably clear of every ring roundabout and street joining the ring.
 */
function ringMouth(state: BuildState, street: RingStreet, id: string): Vec2 | null {
  const { city, ring, pinned, driveways, ringRoundabouts, stubs } = state;
  const { blockers, mouths } = street;
  const known = mouths.get(id);
  if (known) {
    return known;
  }
  const cell = city.cells.get(id)!;
  const centre = cellCentre(cell);
  const joins = [...ringRoundabouts.values(), ...[...stubs.values()].map((s) => s.hit)];
  let best: {
    len: number;
    rank: number;
    hit: NonNullable<ReturnType<typeof ringHit>>;
  } | null = null;
  for (const dir of DIRECTIONS) {
    const hit = ringHit(centre, dir, ring);
    if (!hit) {
      continue;
    }
    const len = Math.hypot(hit.point[0] - centre[0], hit.point[1] - centre[1]);
    let free = true;
    for (let k = 1; k * PITCH < len && free; k++) {
      if (occupied(city, [cell[0] + dir[0] * k, cell[1] + dir[1] * k])) {
        free = false;
      }
    }
    if (free) {
      free = !blockers.some(([a, b]) => segSegIntersect(centre, hit.point, a, b) !== null);
    }
    const clear = joins.every(
      (j) => Math.hypot(j[0] - hit.point[0], j[1] - hit.point[1]) >= RING_ROUNDABOUT_CLEAR,
    );
    const rank = (free ? 0 : 2) + (clear ? 0 : 1);
    if (!best || rank < best.rank || (rank === best.rank && len < best.len)) {
      best = { len, rank, hit };
    }
  }
  if (!best) {
    return null;
  }
  const mouth = attachRing(ring, best.hit, pinned);
  pinned.add(mouth);
  driveways.set(`${id}|${vecKey(mouth)}`, {
    mouth,
    door: doorTowards(state, id, cell, mouth),
    klass: "avenue",
  });
  blockers.push([centre, mouth]);
  mouths.set(id, mouth);
  return mouth;
}

/** Links the lattice could not carry, along the ring between the two buildings' mouths. */
export function routeViaRing(state: BuildState, street: RingStreet, viaRing: ResolvedLink[]): void {
  const { city, ring, pinned, routes, served } = state;
  for (const link of viaRing) {
    const a = ringMouth(state, street, link.fromNodeId);
    const b = ringMouth(state, street, link.toNodeId);
    if (!a || !b) {
      continue;
    }
    const arc = ringArc(ring, a, b);
    for (const p of arc) {
      pinned.add(p);
    }
    routes.set(linkKey(link), {
      points: dedupePoints([
        cellCentre(city.cells.get(link.fromNodeId)!),
        ...arc,
        cellCentre(city.cells.get(link.toNodeId)!),
      ]),
    });
    served.add(link.fromNodeId);
    served.add(link.toNodeId);
  }
}

/** A building no route serves gets its own driveway to the ring (`ring:<id>`). */
export function serveTheRest(state: BuildState, street: RingStreet): void {
  const { city, routes, served } = state;
  for (const id of [...city.cells.keys()].sort()) {
    if (served.has(id)) {
      continue;
    }
    const mouth = ringMouth(state, street, id);
    if (!mouth) {
      continue;
    }
    routes.set(`ring:${id}`, { points: [cellCentre(city.cells.get(id)!), mouth] });
  }
}
