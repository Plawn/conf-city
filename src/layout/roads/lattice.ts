import { PITCH, ROAD_OFFSET } from "../constants";
import { pointInPolygon } from "../geometry";
import type { CityNodesLayout } from "../layoutCity";
import type { Vec2 } from "../types";

/** Corners searched beyond the occupied cells; the ring's inner offset is the real bound. */
const GRID_MARGIN = 1;
/** Neighbour offsets on the corner lattice, indexed by direction. */
export const DIRECTIONS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
/** "No incoming direction yet" in the A* state space. */
export const NO_DIR = DIRECTIONS.length;

/** World position of the corner `(ci, cj)` of the lattice. */
export function cornerPos(ci: number, cj: number): Vec2 {
  return [ci * PITCH + ROAD_OFFSET, cj * PITCH + ROAD_OFFSET];
}

/** The four corners around cell `(i, j)`: NW, NE, SW, SE. */
export function cellCorners(i: number, j: number): [number, number][] {
  return [
    [i - 1, j - 1],
    [i, j - 1],
    [i - 1, j],
    [i, j],
  ];
}

/** Canonical key of a lattice edge, from its lower corner. */
export function edgeKey(ci: number, cj: number, di: number, dj: number): string {
  if (di < 0 || dj < 0) {
    return `${ci + di},${cj + dj},${-di},${-dj}`;
  }
  return `${ci},${cj},${di},${dj}`;
}

export function cornerKey(c: [number, number]): string {
  return `${c[0]},${c[1]}`;
}

/**
 * The corner lattice a city may build streets on: a rectangle around the
 * occupied cells, masked by the ring's inner offset — a corner outside it is
 * not part of the grid at all, so the A* cannot reach it and nothing is ever
 * drawn there.
 */
export interface Grid {
  width: number;
  height: number;
  loI: number;
  loJ: number;
  hiI: number;
  hiJ: number;
  idOf: (ci: number, cj: number) => number;
  inGrid: (ci: number, cj: number) => boolean;
}

export function makeGrid(cells: ReadonlyMap<string, [number, number]>, inner: Vec2[]): Grid {
  let minI = Infinity,
    maxI = -Infinity,
    minJ = Infinity,
    maxJ = -Infinity;
  for (const [i, j] of cells.values()) {
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
  }
  // Corner index range: cell (i, j) touches corners i-1..i and j-1..j.
  const loI = minI - 1 - GRID_MARGIN;
  const hiI = maxI + GRID_MARGIN;
  const loJ = minJ - 1 - GRID_MARGIN;
  const hiJ = maxJ + GRID_MARGIN;
  const width = hiI - loI + 1;
  const height = hiJ - loJ + 1;
  const idOf = (ci: number, cj: number) => (cj - loJ) * width + (ci - loI);
  const usable = new Uint8Array(width * height);
  for (let cj = loJ; cj <= hiJ; cj++) {
    for (let ci = loI; ci <= hiI; ci++) {
      if (pointInPolygon(cornerPos(ci, cj), inner)) {
        usable[idOf(ci, cj)] = 1;
      }
    }
  }
  return {
    width,
    height,
    loI,
    loJ,
    hiI,
    hiJ,
    idOf,
    inGrid: (ci, cj) =>
      ci >= loI && ci <= hiI && cj >= loJ && cj <= hiJ && usable[idOf(ci, cj)] === 1,
  };
}

/** Corners from `c` outwards along `dir`, up to the last one still in the grid. */
export function walkOut(
  c: [number, number],
  dir: [number, number],
  grid: Grid,
): [number, number][] {
  const out: [number, number][] = [c];
  let cur = c;
  for (;;) {
    const next: [number, number] = [cur[0] + dir[0], cur[1] + dir[1]];
    if (!grid.inGrid(next[0], next[1])) {
      return out;
    }
    out.push(next);
    cur = next;
  }
}

export function cellCentre(cell: [number, number]): Vec2 {
  return [cell[0] * PITCH, cell[1] * PITCH];
}

/** `cells` is keyed by node id, so occupancy has to be looked up by value. */
export function occupied(city: CityNodesLayout, cell: [number, number]): boolean {
  for (const c of city.cells.values()) {
    if (c[0] === cell[0] && c[1] === cell[1]) {
      return true;
    }
  }
  return false;
}
