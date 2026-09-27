import type { ResolvedLink } from "../../domain/types";
import { ROUNDABOUT_RADIUS } from "../constants";
import { vecKey } from "../geometry";
import type { CityNodesLayout } from "../layoutCity";
import {
  type Driveway,
  linkKey,
  type RoadClass,
  type RoadNetwork,
  type RoadRoute,
  type Roundabout,
  type Vec2,
} from "../types";
import { connectLattice } from "./access";
import { routeCorners } from "./astar";
import { type GateRequest, makeRing } from "./bridgehead";
import {
  addDir,
  attachDriveway,
  type BuildState,
  claimEdges,
  doorTowards,
  openDriveway,
  usableCorners,
} from "./buildState";
import { cellCentre, cornerKey, cornerPos, type Grid } from "./lattice";
import { ringStreet, routeViaRing, serveTheRest } from "./ringStreet";
import {
  classOf,
  dedupeLinks,
  dedupePoints,
  heavier,
  mergeSegments,
  pickRoundabouts,
  ringSegments,
} from "./segments";

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

  const state: BuildState = {
    city,
    grid,
    ring,
    typeOf: new Map(city.nodes.map((n) => [n.id, n.type] as const)),
    routes,
    edgeUse: new Map(),
    cornerDirs: new Map(),
    driveways: new Map(),
    stubs: new Map(),
    ringRoundabouts: new Map(),
    served: new Set(),
    pinned: new Set(),
  };
  for (const g of gates) {
    state.pinned.add(g.gate.hit);
  }

  const viaRing = routeIntraLinks(state, intraLinks);
  routeFeeders(state, gates);
  connectLattice(state);
  const street = ringStreet(state);
  routeViaRing(state, street, viaRing);
  serveTheRest(state, street);
  return assemble(state);
}

/**
 * Intra-city links: shared streets on the lattice. Returns the links the
 * lattice cannot carry — a city too thin to have a usable corner — which ride
 * the ring instead.
 */
function routeIntraLinks(state: BuildState, intraLinks: ResolvedLink[]): ResolvedLink[] {
  const { city, grid, edgeUse, routes, served } = state;
  const viaRing: ResolvedLink[] = [];
  for (const link of dedupeLinks(intraLinks)) {
    const from = city.cells.get(link.fromNodeId);
    const to = city.cells.get(link.toNodeId);
    if (!from || !to || (from[0] === to[0] && from[1] === to[1])) {
      continue;
    }
    const sources = usableCorners(grid, from);
    const targets = usableCorners(grid, to);
    const corners =
      sources.length > 0 && targets.length > 0 ? routeCorners(sources, targets, grid, edgeUse) : [];
    const head = corners.length > 0 ? attachDriveway(from, corners, grid) : null;
    const tail = head ? attachDriveway(to, [...head.corners].reverse(), grid) : null;
    if (!head || !tail) {
      viaRing.push(link);
      continue;
    }
    const full = [...tail.corners].reverse();
    claimEdges(state, full);
    openDriveway(state, link.fromNodeId, from, head);
    openDriveway(state, link.toNodeId, to, tail);
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
  return viaRing;
}

/** Feeders to the bridgeheads: streets to the gate corner, then the stub to the ring. */
function routeFeeders(state: BuildState, gates: GateRequest[]): void {
  const { city, grid, edgeUse, routes, served, driveways, stubs, ringRoundabouts } = state;
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
        driveways.set(key, {
          mouth,
          door: doorTowards(state, g.nodeId, from, mouth),
          klass: "avenue",
        });
      }
      routes.set(g.key, { points: [cellCentre(from), mouth] });
      served.add(g.nodeId);
      continue;
    }
    const sources = usableCorners(grid, from);
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
    claimEdges(state, full);
    openDriveway(state, g.nodeId, from, head);
    const last = full[full.length - 1]!;
    const lastPos = cornerPos(last[0], last[1]);
    const stubKey = `${cornerKey(last)}|${vecKey(gate.hit)}`;
    const stub = stubs.get(stubKey) ?? { corner: last, hit: gate.hit, uses: 0 };
    stub.uses += 1;
    stubs.set(stubKey, stub);
    addDir(
      state,
      last,
      `${Math.sign(gate.hit[0] - lastPos[0])},${Math.sign(gate.hit[1] - lastPos[1])}`,
    );
    const points = dedupePoints([
      cellCentre(from),
      head.mouth,
      ...full.slice(1).map(([ci, cj]) => cornerPos(ci, cj)),
      gate.hit,
    ]);
    routes.set(g.key, { points });
    served.add(g.nodeId);
  }
}

/** Roundabouts, driveways and segments out of the routed state. */
function assemble(state: BuildState): RoadNetwork {
  const { ring, routes, edgeUse, cornerDirs, driveways, stubs, ringRoundabouts } = state;
  // Roundabouts: bridgeheads first (already placed), then the busiest crossroads.
  const ringCentres = [...ringRoundabouts.keys()].sort().map((k) => ringRoundabouts.get(k)!);
  const junctions = pickRoundabouts(cornerDirs, routes, ringCentres, ring);
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
  // The ring is cut wherever a road joins it: bridgehead roundabouts and access Ts.
  const joins = new Set(ringRoundabouts.keys());
  for (const s of stubs.values()) {
    joins.add(vecKey(s.hit));
  }
  segments.push(...ringSegments(ring, joins));

  return { segments, roundabouts, driveways: drivewayList, ring, routes };
}
