import type { NodeType } from "../../domain/types";
import { footprintRadius } from "../constants";
import { vecKey } from "../geometry";
import type { CityNodesLayout } from "../layoutCity";
import type { Driveway, RoadRoute, Vec2 } from "../types";
import { cellCentre, cellCorners, cornerKey, cornerPos, edgeKey, type Grid } from "./lattice";
import { midpoint } from "./segments";

/** The driveway stops this far outside the footprint, clear of the building's gauge ring. */
const DOOR_MARGIN = 0.2;

/**
 * Makes a route leave its building by a driveway onto a street running along
 * the plot. `corners[0]` is a corner of the cell; if the route continues along
 * the plot's side, the driveway opens onto that first edge, mid-block.
 * Otherwise a short street along the plot is prepended, from a neighbouring
 * corner of the cell, and the driveway opens onto that. `null` when the plot
 * has no usable side there (a corner cut off by the ring).
 */
export function attachDriveway(
  cell: [number, number],
  corners: [number, number][],
  grid: Grid,
): { corners: [number, number][]; mouth: Vec2; edge: string } | null {
  const c0 = corners[0]!;
  const c1 = corners[1];
  const alongSide = (c: [number, number]) =>
    Math.abs(c[0] - c0[0]) + Math.abs(c[1] - c0[1]) === 1 &&
    grid.inGrid(c[0], c[1]) &&
    cellCorners(cell[0], cell[1]).some(([i, j]) => i === c[0] && j === c[1]);
  if (c1 && alongSide(c1)) {
    return {
      corners,
      mouth: midpoint(cornerPos(c0[0], c0[1]), cornerPos(c1[0], c1[1])),
      edge: edgeKey(c0[0], c0[1], c1[0] - c0[0], c1[1] - c0[1]),
    };
  }
  // Two corners of the plot neighbour `c0`; the fixed order keeps the pick stable.
  const side = cellCorners(cell[0], cell[1]).find(alongSide);
  if (!side) {
    return null;
  }
  return {
    corners: [side, ...corners],
    mouth: midpoint(cornerPos(side[0], side[1]), cornerPos(c0[0], c0[1])),
    edge: edgeKey(side[0], side[1], c0[0] - side[0], c0[1] - side[1]),
  };
}

/** A straight stub from the last lattice corner to a bridgehead on the ring. */
export interface Stub {
  corner: [number, number];
  hit: Vec2;
  uses: number;
}

/** What the phases of `buildRoadNetwork` share; insertion order of every map is load-bearing. */
export interface BuildState {
  city: CityNodesLayout;
  grid: Grid;
  ring: Vec2[];
  typeOf: ReadonlyMap<string, NodeType>;
  routes: Map<string, RoadRoute>;
  edgeUse: Map<string, number>;
  cornerDirs: Map<string, Set<string>>;
  driveways: Map<string, Driveway>;
  stubs: Map<string, Stub>;
  ringRoundabouts: Map<string, Vec2>;
  /** Nodes some route already reaches — the others get their own way to the ring. */
  served: Set<string>;
  /** Ring vertices handed out as bridgeheads: never moved by a later attach. */
  pinned: Set<Vec2>;
}

export function addDir(state: BuildState, c: [number, number], dir: string): void {
  const key = cornerKey(c);
  let set = state.cornerDirs.get(key);
  if (!set) {
    set = new Set();
    state.cornerDirs.set(key, set);
  }
  set.add(dir);
}

export function claimEdges(state: BuildState, corners: [number, number][]): void {
  for (let k = 0; k + 1 < corners.length; k++) {
    const [ci, cj] = corners[k]!;
    const [ni, nj] = corners[k + 1]!;
    const di = ni - ci;
    const dj = nj - cj;
    const key = edgeKey(ci, cj, di, dj);
    state.edgeUse.set(key, (state.edgeUse.get(key) ?? 0) + 1);
    addDir(state, corners[k]!, `${di},${dj}`);
    addDir(state, corners[k + 1]!, `${-di},${-dj}`);
  }
}

export function openDriveway(
  state: BuildState,
  nodeId: string,
  cell: [number, number],
  head: { mouth: Vec2; edge: string },
): void {
  const key = `${nodeId}|${vecKey(head.mouth)}`;
  if (!state.driveways.has(key)) {
    state.driveways.set(key, {
      mouth: head.mouth,
      door: doorTowards(state, nodeId, cell, head.mouth),
      klass: "street",
      ...{ edge: head.edge },
    } as Driveway);
  }
}

export function doorTowards(
  state: BuildState,
  nodeId: string,
  cell: [number, number],
  mouth: Vec2,
): Vec2 {
  const centre = cellCentre(cell);
  const dx = mouth[0] - centre[0];
  const dz = mouth[1] - centre[1];
  const len = Math.hypot(dx, dz) || 1;
  const reach = footprintRadius(state.typeOf.get(nodeId) ?? "app") + DOOR_MARGIN;
  return [centre[0] + (dx / len) * reach, centre[1] + (dz / len) * reach];
}

export function usableCorners(grid: Grid, cell: [number, number]): [number, number][] {
  return cellCorners(cell[0], cell[1]).filter(([i, j]) => grid.inGrid(i, j));
}
