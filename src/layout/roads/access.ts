import { PITCH, RING_ROUNDABOUT_CLEAR, RING_STUB_MIN } from "../constants";
import { segSegIntersect, vecKey } from "../geometry";
import { attachRing, ringHit } from "../ringRoad";
import type { Vec2 } from "../types";
import { addDir, type BuildState, claimEdges } from "./buildState";
import { cornerKey, cornerPos, DIRECTIONS, walkOut } from "./lattice";

/**
 * Joins every piece of the street grid no stub reaches to the ring road, by one
 * access street: a straight way out from one of its corners (`walkOut`, as a
 * bridgehead feeder), then a stub meeting the ring at a T. Without it a city
 * with no bridge is a lattice floating inside its ring, and so is any cluster
 * of links the others never touch. Candidates whose stub is `RING_STUB_MIN`
 * long and whose T keeps `RING_ROUNDABOUT_CLEAR` from every other road joining
 * the ring win; then the least new asphalt.
 */
export function connectLattice(state: BuildState): void {
  const { edgeUse, stubs, grid, ring, pinned, ringRoundabouts } = state;
  if (ring.length < 3) {
    return;
  }
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) {
      return k;
    }
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  const corners = new Map<string, [number, number]>();
  for (const key of edgeUse.keys()) {
    const [ci, cj, di, dj] = key.split(",").map(Number) as [number, number, number, number];
    const a: [number, number] = [ci, cj];
    const b: [number, number] = [ci + di, cj + dj];
    corners.set(cornerKey(a), a);
    corners.set(cornerKey(b), b);
    parent.set(find(cornerKey(a)), find(cornerKey(b)));
  }
  const reached = new Set([...stubs.values()].map((s) => find(cornerKey(s.corner))));
  const pieces = new Map<string, [number, number][]>();
  for (const key of [...corners.keys()].sort()) {
    const root = find(key);
    if (!reached.has(root)) {
      pieces.set(root, [...(pieces.get(root) ?? []), corners.get(key)!]);
    }
  }

  for (const piece of pieces.values()) {
    const blockers: [Vec2, Vec2][] = [];
    for (const key of edgeUse.keys()) {
      const [ci, cj, di, dj] = key.split(",").map(Number) as [number, number, number, number];
      blockers.push([cornerPos(ci, cj), cornerPos(ci + di, cj + dj)]);
    }
    const joins = [...ringRoundabouts.values()];
    for (const s of stubs.values()) {
      blockers.push([cornerPos(s.corner[0], s.corner[1]), s.hit]);
      joins.push(s.hit);
    }
    let best: {
      tier: number;
      cost: number;
      path: [number, number][];
      dir: [number, number];
      hit: NonNullable<ReturnType<typeof ringHit>>;
    } | null = null;
    for (const c of piece) {
      for (const dir of DIRECTIONS) {
        const path = walkOut(c, dir, grid);
        const last = path[path.length - 1]!;
        const from = cornerPos(last[0], last[1]);
        const hit = ringHit(from, dir, ring);
        if (!hit) {
          continue;
        }
        // A stub must not run over another street past the grid's edge.
        const crosses = blockers.some(
          ([a, b]) =>
            !same(a, from) && !same(b, from) && segSegIntersect(from, hit.point, a, b) !== null,
        );
        if (crosses) {
          continue;
        }
        const stub = Math.hypot(hit.point[0] - from[0], hit.point[1] - from[1]);
        const clear = joins.every(
          (j) => Math.hypot(j[0] - hit.point[0], j[1] - hit.point[1]) >= RING_ROUNDABOUT_CLEAR,
        );
        const tier = (stub >= RING_STUB_MIN ? 0 : 1) + (clear ? 0 : 2);
        const cost = (path.length - 1) * PITCH + stub;
        if (!best || tier < best.tier || (tier === best.tier && cost < best.cost)) {
          best = { tier, cost, path, dir, hit };
        }
      }
    }
    if (!best) {
      continue;
    }
    claimEdges(state, best.path);
    const last = best.path[best.path.length - 1]!;
    const hit = attachRing(ring, best.hit, pinned);
    pinned.add(hit);
    stubs.set(`${cornerKey(last)}|${vecKey(hit)}`, { corner: last, hit, uses: 1 });
    addDir(state, last, `${best.dir[0]},${best.dir[1]}`);
  }
}

function same(a: Vec2, b: Vec2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
