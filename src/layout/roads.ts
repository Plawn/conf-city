import type { ResolvedLink } from "../domain/types";
import {
  footprintRadius,
  PITCH,
  RING_ROUNDABOUT_CLEAR,
  ROAD_OFFSET,
  ROUNDABOUT_RADIUS,
  ROUNDABOUT_SPACING,
} from "./constants";
import { centroid, pointInPolygon, segSegIntersect, vecKey } from "./geometry";
import type { CityNodesLayout } from "./layoutCity";
import { attachRing, buildRing, ringHit } from "./ringRoad";
import {
  type Driveway,
  linkKey,
  type RoadClass,
  type RoadNetwork,
  type RoadRoute,
  type RoadSegment,
  type Roundabout,
  type Vec2,
} from "./types";

/**
 * Turns the intra-city links of one city into a shared street grid, wrapped in
 * the ring road every building can reach.
 *
 * Streets run on the *corner* lattice — `((i+0.5)·PITCH, (j+0.5)·PITCH)` — which
 * threads between buildings sitting at cell centres, so a road never crosses a
 * plot. Only the corners inside the ring's inner offset are usable, so a street
 * never ends up under the ring's tarmac. Each link is routed with A* in
 * Manhattan distance; an edge already used by a previous link costs 0.6 instead
 * of 1, so links converge onto trunk roads instead of each drawing its own
 * street, and every change of direction costs 0.5, so a route prefers one long
 * street to a staircase. Links are routed in `linkKey` order, which is what
 * makes the sharing deterministic.
 *
 * A building is reached the way a real one is: by a driveway opening onto a
 * street that runs along its plot, joined mid-block (`attachDriveway`). Every
 * route therefore starts and ends on drawn asphalt, and a vehicle never cuts
 * across the plot corner to reach the door.
 *
 * The ring: a bridge lands on it at a bridgehead roundabout, reached from the
 * lattice by a short straight stub — the one kind of road that is neither on
 * the lattice nor on the ring (`planBridgehead`). A building no route serves
 * gets a driveway straight from its door to the ring (`ring:<id>` route), the
 * way a house on a ring road does, picking the side whose way out crosses
 * neither a plot nor a street.
 *
 * Roundabouts go where traffic converges *and* where there is room for one: a
 * lattice corner qualifies when three or more streets meet there (a driveway is
 * a kerb cut, not a street), and the qualified corners are taken by decreasing
 * number of routes through them, dropping any that lies within
 * `ROUNDABOUT_SPACING` of one already kept or of a bridgehead. The corners that
 * lose out stay plain crossroads. Route points and roundabout centres are
 * matched by exact coordinate equality, which holds because every point here is
 * built from the same integer × PITCH arithmetic, or is the very `Vec2` the
 * ring holds.
 *
 * How many routes ended up on an edge is kept, not just *that* one did: it is
 * the only measure of importance the street grid has, and it becomes the road
 * class (`street` / `avenue` / `boulevard`) the renderer draws wider and paler.
 */

/** Cost of an edge no route uses yet; a shared edge costs `SHARED_COST`. */
const FRESH_COST = 1;
const SHARED_COST = 0.6;
/** Paid at every change of direction: straight streets, not staircases. */
const TURN_COST = 0.5;
/** Routes on an edge from which it is drawn as an avenue / a boulevard. */
const AVENUE_FROM = 2;
const BOULEVARD_FROM = 3;
/** Corners searched beyond the occupied cells; the ring's inner offset is the real bound. */
const GRID_MARGIN = 1;
/** Neighbour offsets on the corner lattice, indexed by direction. */
const DIRECTIONS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
/** "No incoming direction yet" in the A* state space. */
const NO_DIR = DIRECTIONS.length;
/** The driveway stops this far outside the footprint, clear of the building's gauge ring. */
const DOOR_MARGIN = 0.2;
/** A bridgehead a bit further up the ring is worth a slightly longer way to it. */
const DEEP_WEIGHT = 0.25;

/** World position of the corner `(ci, cj)` of the lattice. */
export function cornerPos(ci: number, cj: number): Vec2 {
  return [ci * PITCH + ROAD_OFFSET, cj * PITCH + ROAD_OFFSET];
}

/** The four corners around cell `(i, j)`: NW, NE, SW, SE. */
function cellCorners(i: number, j: number): [number, number][] {
  return [
    [i - 1, j - 1],
    [i, j - 1],
    [i - 1, j],
    [i, j],
  ];
}

/** Canonical key of a lattice edge, from its lower corner. */
function edgeKey(ci: number, cj: number, di: number, dj: number): string {
  if (di < 0 || dj < 0) {
    return `${ci + di},${cj + dj},${-di},${-dj}`;
  }
  return `${ci},${cj},${di},${dj}`;
}

function cornerKey(c: [number, number]): string {
  return `${c[0]},${c[1]}`;
}

class Heap {
  private items: { id: number; f: number; seq: number }[] = [];
  private seq = 0;

  push(id: number, f: number): void {
    const item = { id, f, seq: this.seq++ };
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.items.length && this.less(l, best)) {
          best = l;
        }
        if (r < this.items.length && this.less(r, best)) {
          best = r;
        }
        if (best === i) {
          break;
        }
        this.swap(i, best);
        i = best;
      }
    }
    return top.id;
  }

  get size(): number {
    return this.items.length;
  }

  private less(a: number, b: number): boolean {
    const x = this.items[a]!;
    const y = this.items[b]!;
    return x.f < y.f || (x.f === y.f && x.seq < y.seq);
  }

  private swap(a: number, b: number): void {
    const tmp = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = tmp;
  }
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

/** Corners from `c` outwards along `dir`, up to the last one still in the grid. */
function walkOut(c: [number, number], dir: [number, number], grid: Grid): [number, number][] {
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

function cellCentre(cell: [number, number]): Vec2 {
  return [cell[0] * PITCH, cell[1] * PITCH];
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Makes a route leave its building by a driveway onto a street running along
 * the plot. `corners[0]` is a corner of the cell; if the route continues along
 * the plot's side, the driveway opens onto that first edge, mid-block.
 * Otherwise a short street along the plot is prepended, from a neighbouring
 * corner of the cell, and the driveway opens onto that. `null` when the plot
 * has no usable side there (a corner cut off by the ring).
 */
function attachDriveway(
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

function dedupePoints(points: Vec2[]): Vec2[] {
  return points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1],
  );
}

function classOf(uses: number): RoadClass {
  if (uses >= BOULEVARD_FROM) {
    return "boulevard";
  }
  if (uses >= AVENUE_FROM) {
    return "avenue";
  }
  return "street";
}

const CLASS_RANK: Record<RoadClass, number> = { street: 0, avenue: 1, boulevard: 2 };

function heavier(a: RoadClass, b: RoadClass): RoadClass {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

function dedupeLinks(links: ResolvedLink[]): ResolvedLink[] {
  const byKey = new Map<string, ResolvedLink>();
  for (const l of links) {
    const key = linkKey(l);
    if (!byKey.has(key)) {
      byKey.set(key, l);
    }
  }
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

/** A straight stub from the last lattice corner to a bridgehead on the ring. */
interface Stub {
  corner: [number, number];
  hit: Vec2;
  uses: number;
}

export function buildRoadNetwork(
  city: CityNodesLayout,
  intraLinks: ResolvedLink[],
  gates: GateRequest[] = [],
  ringIn?: { ring: Vec2[]; grid: Grid },
): RoadNetwork {
  const routes = new Map<string, RoadRoute>();
  if (city.cells.size === 0) {
    return { segments: [], roundabouts: [], driveways: [], ring: [], routes };
  }
  const { ring, grid } = ringIn ?? makeRing(city);

  const edgeUse = new Map<string, number>();
  const cornerDirs = new Map<string, Set<string>>();
  const driveways = new Map<string, Driveway>();
  const stubs = new Map<string, Stub>();
  const ringRoundabouts = new Map<string, Vec2>();
  /** Nodes some route already reaches — the others get their own way to the ring. */
  const served = new Set<string>();
  /** Ring vertices handed out as bridgeheads: never moved by a later attach. */
  const pinned = new Set<Vec2>();
  for (const g of gates) {
    pinned.add(g.gate.hit);
  }

  const typeOf = new Map(city.nodes.map((n) => [n.id, n.type] as const));
  const addDir = (c: [number, number], dir: string) => {
    const key = cornerKey(c);
    let set = cornerDirs.get(key);
    if (!set) {
      set = new Set();
      cornerDirs.set(key, set);
    }
    set.add(dir);
  };
  const claimEdges = (corners: [number, number][]) => {
    for (let k = 0; k + 1 < corners.length; k++) {
      const [ci, cj] = corners[k]!;
      const [ni, nj] = corners[k + 1]!;
      const di = ni - ci;
      const dj = nj - cj;
      const key = edgeKey(ci, cj, di, dj);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      addDir(corners[k]!, `${di},${dj}`);
      addDir(corners[k + 1]!, `${-di},${-dj}`);
    }
  };
  const openDriveway = (
    nodeId: string,
    cell: [number, number],
    head: { mouth: Vec2; edge: string },
  ) => {
    const key = `${nodeId}|${vecKey(head.mouth)}`;
    if (!driveways.has(key)) {
      driveways.set(key, {
        mouth: head.mouth,
        door: doorTowards(nodeId, cell, head.mouth),
        klass: "street",
        ...{ edge: head.edge },
      } as Driveway);
    }
  };
  const doorTowards = (nodeId: string, cell: [number, number], mouth: Vec2): Vec2 => {
    const centre = cellCentre(cell);
    const dx = mouth[0] - centre[0];
    const dz = mouth[1] - centre[1];
    const len = Math.hypot(dx, dz) || 1;
    const reach = footprintRadius(typeOf.get(nodeId) ?? "app") + DOOR_MARGIN;
    return [centre[0] + (dx / len) * reach, centre[1] + (dz / len) * reach];
  };
  const usableCorners = (cell: [number, number]) =>
    cellCorners(cell[0], cell[1]).filter(([i, j]) => grid.inGrid(i, j));

  // Intra-city links: shared streets on the lattice. A link the lattice cannot
  // carry — a city too thin to have a usable corner — rides the ring instead.
  const viaRing: ResolvedLink[] = [];
  for (const link of dedupeLinks(intraLinks)) {
    const from = city.cells.get(link.fromNodeId);
    const to = city.cells.get(link.toNodeId);
    if (!from || !to || (from[0] === to[0] && from[1] === to[1])) {
      continue;
    }
    const sources = usableCorners(from);
    const targets = usableCorners(to);
    const corners =
      sources.length > 0 && targets.length > 0 ? routeCorners(sources, targets, grid, edgeUse) : [];
    const head = corners.length > 0 ? attachDriveway(from, corners, grid) : null;
    const tail = head ? attachDriveway(to, [...head.corners].reverse(), grid) : null;
    if (!head || !tail) {
      viaRing.push(link);
      continue;
    }
    const full = [...tail.corners].reverse();
    claimEdges(full);
    openDriveway(link.fromNodeId, from, head);
    openDriveway(link.toNodeId, to, tail);
    const points = dedupePoints([
      cellCentre(from),
      head.mouth,
      ...full.slice(1, -1).map(([ci, cj]) => cornerPos(ci, cj)),
      tail.mouth,
      cellCentre(to),
    ]);
    routes.set(linkKey(link), { points });
    served.add(link.fromNodeId);
    served.add(link.toNodeId);
  }

  // Feeders to the bridgeheads: streets to the gate corner, then the stub to the ring.
  for (const g of [...gates].sort((a, b) => a.key.localeCompare(b.key))) {
    const from = city.cells.get(g.nodeId);
    if (!from) {
      continue;
    }
    const { gate } = g;
    ringRoundabouts.set(vecKey(gate.hit), gate.hit);
    if (gate.corner === null) {
      if (gate.driveway !== g.nodeId) {
        continue;
      }
      const mouth = gate.hit;
      const key = `${g.nodeId}|${vecKey(mouth)}`;
      if (!driveways.has(key)) {
        driveways.set(key, { mouth, door: doorTowards(g.nodeId, from, mouth), klass: "avenue" });
      }
      routes.set(g.key, { points: [cellCentre(from), mouth] });
      served.add(g.nodeId);
      continue;
    }
    const sources = usableCorners(from);
    if (sources.length === 0) {
      continue;
    }
    const corners = routeCorners(sources, gate.path, grid, edgeUse);
    if (corners.length === 0) {
      continue;
    }
    const head = attachDriveway(from, corners, grid);
    if (!head) {
      continue;
    }
    // The A* may land anywhere on the spur; continue outwards from there.
    const reached = corners[corners.length - 1]!;
    const at = gate.path.findIndex(([i, j]) => i === reached[0] && j === reached[1]);
    const full = [...head.corners, ...gate.path.slice(at + 1)];
    claimEdges(full);
    openDriveway(g.nodeId, from, head);
    const last = full[full.length - 1]!;
    const lastPos = cornerPos(last[0], last[1]);
    const stubKey = `${cornerKey(last)}|${vecKey(gate.hit)}`;
    const stub = stubs.get(stubKey) ?? { corner: last, hit: gate.hit, uses: 0 };
    stub.uses += 1;
    stubs.set(stubKey, stub);
    addDir(last, `${Math.sign(gate.hit[0] - lastPos[0])},${Math.sign(gate.hit[1] - lastPos[1])}`);
    const points = dedupePoints([
      cellCentre(from),
      head.mouth,
      ...full.slice(1).map(([ci, cj]) => cornerPos(ci, cj)),
      gate.hit,
    ]);
    routes.set(g.key, { points });
    served.add(g.nodeId);
  }

  // The ring as a street: what a building nothing else reaches opens onto, and
  // what carries a link between two buildings the lattice could not join.
  const blockers: [Vec2, Vec2][] = [];
  for (const key of edgeUse.keys()) {
    const [ci, cj, di, dj] = key.split(",").map(Number) as [number, number, number, number];
    blockers.push([cornerPos(ci, cj), cornerPos(ci + di, cj + dj)]);
  }
  for (const s of stubs.values()) {
    blockers.push([cornerPos(s.corner[0], s.corner[1]), s.hit]);
  }
  const ringMouths = new Map<string, Vec2>();
  /** One driveway per building onto the ring: the shortest axial way out that crosses nothing. */
  const ringMouth = (id: string): Vec2 | null => {
    const known = ringMouths.get(id);
    if (known) {
      return known;
    }
    const cell = city.cells.get(id)!;
    const centre = cellCentre(cell);
    let best: { len: number; free: boolean; hit: NonNullable<ReturnType<typeof ringHit>> } | null =
      null;
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
      if (!best || (free && !best.free) || (free === best.free && len < best.len)) {
        best = { len, free, hit };
      }
    }
    if (!best) {
      return null;
    }
    const mouth = attachRing(ring, best.hit, pinned);
    pinned.add(mouth);
    driveways.set(`${id}|${vecKey(mouth)}`, {
      mouth,
      door: doorTowards(id, cell, mouth),
      klass: "avenue",
    });
    blockers.push([centre, mouth]);
    ringMouths.set(id, mouth);
    return mouth;
  };

  for (const link of viaRing) {
    const a = ringMouth(link.fromNodeId);
    const b = ringMouth(link.toNodeId);
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

  for (const id of [...city.cells.keys()].sort()) {
    if (served.has(id)) {
      continue;
    }
    const mouth = ringMouth(id);
    if (!mouth) {
      continue;
    }
    routes.set(`ring:${id}`, { points: [cellCentre(city.cells.get(id)!), mouth] });
  }

  // Roundabouts: bridgeheads first (already placed), then the busiest crossroads.
  const ringCentres = [...ringRoundabouts.keys()].sort().map((k) => ringRoundabouts.get(k)!);
  const junctions = pickRoundabouts(cornerDirs, routes, ringCentres);
  const cornerClass = new Map<string, RoadClass>();
  const bumpCorner = (key: string, klass: RoadClass) =>
    cornerClass.set(key, heavier(cornerClass.get(key) ?? "street", klass));
  for (const [key, uses] of edgeUse) {
    const [ci, cj, di, dj] = key.split(",").map(Number) as [number, number, number, number];
    const klass = classOf(uses);
    bumpCorner(`${ci},${cj}`, klass);
    bumpCorner(`${ci + di},${cj + dj}`, klass);
  }
  const roundabouts: Roundabout[] = [...junctions].sort().map((k) => {
    const [ci, cj] = k.split(",").map(Number) as [number, number];
    return {
      center: cornerPos(ci, cj),
      radius: ROUNDABOUT_RADIUS,
      klass: cornerClass.get(k) ?? "street",
    };
  });
  for (const centre of ringCentres) {
    roundabouts.push({ center: centre, radius: ROUNDABOUT_RADIUS, klass: "avenue" });
  }

  const drivewayList: Driveway[] = [...driveways.keys()].sort().map((k) => {
    const d = driveways.get(k)! as Driveway & { edge?: string };
    const klass: RoadClass = d.edge ? classOf(edgeUse.get(d.edge) ?? 1) : d.klass;
    return { mouth: d.mouth, door: d.door, klass };
  });

  const segments = mergeSegments(edgeUse, junctions, cornerDirs);
  for (const key of [...stubs.keys()].sort()) {
    const s = stubs.get(key)!;
    segments.push({ points: [cornerPos(s.corner[0], s.corner[1]), s.hit], klass: classOf(s.uses) });
  }
  segments.push(...ringSegments(ring, ringRoundabouts));

  return { segments, roundabouts, driveways: drivewayList, ring, routes };
}

function makeRing(city: CityNodesLayout): { ring: Vec2[]; grid: Grid } {
  const { ring, inner } = buildRing(city.nodes);
  return { ring, grid: makeGrid(city.cells, inner) };
}

/** `cells` is keyed by node id, so occupancy has to be looked up by value. */
function occupied(city: CityNodesLayout, cell: [number, number]): boolean {
  for (const c of city.cells.values()) {
    if (c[0] === cell[0] && c[1] === cell[1]) {
      return true;
    }
  }
  return false;
}

/** The ring vertices from `a` to `b` (both included), the shorter way round. */
function ringArc(ring: Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const ia = ring.indexOf(a);
  const ib = ring.indexOf(b);
  if (ia < 0 || ib < 0) {
    return [a, b];
  }
  if (ia === ib) {
    return [a];
  }
  const n = ring.length;
  const walk = (step: 1 | -1): { points: Vec2[]; length: number } => {
    const points: Vec2[] = [a];
    let length = 0;
    for (let i = ia; i !== ib; ) {
      const j = (i + step + n) % n;
      length += Math.hypot(ring[j]![0] - ring[i]![0], ring[j]![1] - ring[i]![1]);
      points.push(ring[j]!);
      i = j;
    }
    return { points, length };
  };
  const cw = walk(1);
  const ccw = walk(-1);
  return cw.length <= ccw.length ? cw.points : ccw.points;
}

/**
 * A* from any of `sources` to any of `targets` on the corner lattice, with the
 * incoming direction in the state so a turn can be charged. Returns the
 * corners from source to target, or `[]` when the grid does not connect them.
 */
function routeCorners(
  sources: [number, number][],
  targets: [number, number][],
  grid: Grid,
  edgeUse: ReadonlyMap<string, number>,
): [number, number][] {
  const states = grid.width * grid.height * (NO_DIR + 1);
  const g = new Float64Array(states).fill(Infinity);
  const cameFrom = new Int32Array(states).fill(-1);
  const closed = new Uint8Array(states);
  const targetIds = new Set(targets.map(([i, j]) => grid.idOf(i, j)));
  const h = (ci: number, cj: number) => {
    let best = Infinity;
    for (const [ti, tj] of targets) {
      best = Math.min(best, Math.abs(ti - ci) + Math.abs(tj - cj));
    }
    return best * SHARED_COST;
  };
  const heap = new Heap();
  for (const [ci, cj] of sources) {
    const st = grid.idOf(ci, cj) * (NO_DIR + 1) + NO_DIR;
    g[st] = 0;
    heap.push(st, h(ci, cj));
  }

  let goal = -1;
  while (heap.size > 0) {
    const st = heap.pop()!;
    if (closed[st]) {
      continue;
    }
    closed[st] = 1;
    const id = Math.floor(st / (NO_DIR + 1));
    const dirIn = st % (NO_DIR + 1);
    if (targetIds.has(id)) {
      goal = st;
      break;
    }
    const ci = grid.loI + (id % grid.width);
    const cj = grid.loJ + Math.floor(id / grid.width);
    for (let d = 0; d < DIRECTIONS.length; d++) {
      const [di, dj] = DIRECTIONS[d]!;
      const ni = ci + di;
      const nj = cj + dj;
      if (!grid.inGrid(ni, nj)) {
        continue;
      }
      const step = edgeUse.has(edgeKey(ci, cj, di, dj)) ? SHARED_COST : FRESH_COST;
      const turn = dirIn !== NO_DIR && dirIn !== d ? TURN_COST : 0;
      const nst = grid.idOf(ni, nj) * (NO_DIR + 1) + d;
      const ng = g[st]! + step + turn;
      if (ng < g[nst]!) {
        g[nst] = ng;
        cameFrom[nst] = st;
        heap.push(nst, ng + h(ni, nj));
      }
    }
  }
  if (goal < 0) {
    return [];
  }

  const out: [number, number][] = [];
  for (let st = goal; st >= 0; st = cameFrom[st]!) {
    const id = Math.floor(st / (NO_DIR + 1));
    out.push([grid.loI + (id % grid.width), grid.loJ + Math.floor(id / grid.width)]);
  }
  return out.reverse();
}

/**
 * Which lattice crossroads become roundabouts: corners where three or more
 * streets meet, busiest first, kept `ROUNDABOUT_SPACING` apart from each other
 * and from the bridgehead roundabouts already on the ring.
 */
function pickRoundabouts(
  cornerDirs: ReadonlyMap<string, Set<string>>,
  routes: ReadonlyMap<string, RoadRoute>,
  ringCentres: Vec2[],
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
    if (crowded) {
      continue;
    }
    kept.push(c.pos);
    out.add(c.key);
  }
  return out;
}

/**
 * Lattice edges → straight segments: maximal axis-aligned runs of one class,
 * cut at every roundabout and at every corner where three or more directions
 * meet. A plain bend (two directions) is two segments sharing an end — the
 * renderer fuses those into one curve.
 */
function mergeSegments(
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
 * The ring as avenue segments, cut at every bridgehead roundabout, and always
 * in at least two pieces so no segment is ever a closed loop.
 */
function ringSegments(ring: Vec2[], ringRoundabouts: ReadonlyMap<string, Vec2>): RoadSegment[] {
  const n = ring.length;
  if (n < 3) {
    return [];
  }
  let cuts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ringRoundabouts.has(vecKey(ring[i]!))) {
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
