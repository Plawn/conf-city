import { BIOMES, type BiomeId, DEFAULT_BIOME } from "../domain/biome";
import type { PositionedNode, ResolvedLink, ResolvedNode } from "../domain/types";
import { GOLDEN_ANGLE } from "../lib/math";
import { fnv1a } from "../lib/random";
import { buildBridges, pairKey } from "./bridges";
import {
  DISCOVERY_PADDING,
  FORCE_ITERATIONS,
  GROUP_PADDING,
  HARBOUR_REACH,
  ISLAND_PADDING,
  WATER_GAP,
} from "./constants";
import { type Body, relax, type Spring } from "./force";
import { cellKey, centroid, polygonBounds } from "./geometry";
import { type HarbourSite, planHarbour, translateHarbour } from "./harbour";
import { type CityNodesLayout, layoutCity } from "./layoutCity";
import { footprintCorners, islandOutline, zoneOutline } from "./outline";
import { buildRing } from "./ringRoad";
import { type Bridgehead, type GateRequest, planBridgehead } from "./roads/bridgehead";
import { type Grid, makeGrid } from "./roads/lattice";
import { buildRoadNetwork } from "./roads/network";
import {
  type CityLayout,
  type GroupZone,
  linkKey,
  type RoadNetwork,
  type Vec2,
  type WorldLayout,
} from "./types";
import { placeUtilityPlot, translateUtilityPlot } from "./utilityPlot";

export interface DiscoveredResolvedNode extends ResolvedNode {
  isDiscovered: true;
}

/** Golden angle — same phyllotaxis seed as inside a city, one scale up. */

/**
 * Places every city as an island on the water and returns the whole layout in
 * world coordinates.
 *
 * Each city is laid out locally (buildings, streets, shore), then the islands
 * themselves are relaxed in 2D: inter-city links are springs, so cities that
 * talk to each other end up neighbours, and a hard `WATER_GAP` collision keeps
 * the shores apart. Islands are never rotated — streets stay world-aligned —
 * and offsets are rounded to integers so the lattice survives the translation.
 *
 * `ingress` holds the addresses (`cityId/nodeId`) of the services that are the
 * Internet's way in. They are laid out apart from the rest: kept out of the
 * footprint hull, then dropped back onto the shore as the island's port
 * (`harbour.ts`) — which needs the other islands' positions, hence a step
 * between the island placement and the bridgeheads.
 */
export function layoutWorld(
  cityIds: string[],
  staticNodes: ResolvedNode[],
  links: ResolvedLink[],
  discoveredNodes: DiscoveredResolvedNode[] = [],
  biomes: ReadonlyMap<string, BiomeId> = new Map(),
  ingress: ReadonlySet<string> = new Set(),
): WorldLayout {
  const ids = [...new Set(cityIds)];
  const locals = ids.map((cityId) =>
    buildLocalCity(
      cityId,
      staticNodes,
      links,
      discoveredNodes,
      biomes.get(cityId) ?? DEFAULT_BIOME,
      ingress,
    ),
  );
  const offsets = placeIslands(locals, links);
  planHarbours(locals, offsets);

  // Bridgeheads first: the feeder streets to them are part of the road network,
  // so roads can only be routed once the islands know who faces whom.
  const { pairGates, gateRequests } = planGates(locals, offsets, links);

  const cities = new Map<string, CityLayout>();
  const nodes: PositionedNode[] = [];
  locals.forEach((local, i) => {
    const [dx, dz] = offsets[i]!;
    const roads = buildRoadNetwork(
      local.layout,
      local.intraLinks,
      gateRequests.get(local.cityId) ?? [],
      {
        ring: local.ring,
        grid: local.grid,
      },
    );
    // After the roads: the plot is chosen against the streets that were actually
    // drawn, and against the bridgeheads already attached to the ring.
    const plot = placeUtilityPlot({
      cityId: local.cityId,
      outline: local.outline,
      ring: local.ring,
      roads,
      buildings: local.layout.nodes.map((n) => [n.position[0], n.position[2]] as Vec2),
      gates: (gateRequests.get(local.cityId) ?? []).map((r) => r.gate.hit),
    });
    const cityNodes = local.layout.nodes.map((n) => ({
      ...n,
      position: [n.position[0] + dx, n.position[1], n.position[2] + dz] as [number, number, number],
    }));
    const outline = local.outline.map((p) => translate(p, dx, dz));
    const layout: CityLayout = {
      cityId: local.cityId,
      biome: local.biome,
      nodes: cityNodes,
      center: centroid(outline),
      outline,
      bounds: polygonBounds(outline) ?? { cx: dx, cz: dz, width: 4, height: 4 },
      roads: translateRoads(roads, dx, dz),
      groups: local.groups.map((g) => translateZone(g, dx, dz)),
      ...(local.discoveredZone
        ? { discoveredZone: translateZone(local.discoveredZone, dx, dz) }
        : {}),
      ...(local.harbour ? { harbour: translateHarbour(local.harbour, dx, dz) } : {}),
      ...(plot ? { utilityPlot: translateUtilityPlot(plot, dx, dz) } : {}),
    };
    cities.set(local.cityId, layout);
    nodes.push(...cityNodes);
  });

  return { nodes, cities, bridges: buildBridges(cities, links, pairGates) };
}

/**
 * Plans one bridgehead per (linked city pair, city) on the city's ring road,
 * facing the other island, and attaches it to the ring. Returns the gates in
 * world coordinates per pair (ordered like the pair key) and, per city, the
 * feeder routes `buildRoadNetwork` must add.
 *
 * The bridgehead is one `Vec2` shared by the ring, the roundabout, the feeder
 * route and — translated by the island's integer offset, the same arithmetic
 * `translateRoads` applies — the bridge: what keeps them matching by value.
 */
function planGates(
  locals: LocalCity[],
  offsets: Vec2[],
  links: ResolvedLink[],
): { pairGates: Map<string, [Vec2, Vec2]>; gateRequests: Map<string, GateRequest[]> } {
  const localOf = new Map<string, { local: LocalCity; offset: Vec2 }>();
  locals.forEach((local, i) => {
    localOf.set(local.cityId, { local, offset: offsets[i]! });
  });

  const interLinks = new Map<string, ResolvedLink>();
  for (const l of links) {
    if (!l.interCity || !localOf.has(l.fromCityId) || !localOf.has(l.toCityId)) {
      continue;
    }
    const key = linkKey(l);
    if (!interLinks.has(key)) {
      interLinks.set(key, l);
    }
  }

  // Bridgehead per pair, per city (keyed "pair→cityId").
  const heads = new Map<string, Bridgehead>();
  const pairGates = new Map<string, [Vec2, Vec2]>();
  const pinned = new Map<string, Set<Vec2>>();
  const pairs = [...new Set([...interLinks.values()].map(pairKey))].sort();
  for (const pair of pairs) {
    const [idA, idB] = pair.split("|") as [string, string];
    const a = localOf.get(idA)!;
    const b = localOf.get(idB)!;
    const gateOf = (
      here: { local: LocalCity; offset: Vec2 },
      there: { local: LocalCity; offset: Vec2 },
    ): Bridgehead | null => {
      const centerHere = translate(centroid(here.local.ring), here.offset[0], here.offset[1]);
      const centerThere = translate(centroid(there.local.ring), there.offset[0], there.offset[1]);
      const toward: Vec2 = [centerThere[0] - centerHere[0], centerThere[1] - centerHere[1]];
      let held = pinned.get(here.local.cityId);
      if (!held) {
        held = new Set();
        pinned.set(here.local.cityId, held);
      }
      return planBridgehead(here.local.layout, here.local.grid, here.local.ring, toward, held);
    };
    const gateA = gateOf(a, b);
    const gateB = gateOf(b, a);
    if (!gateA || !gateB) {
      continue;
    }
    heads.set(`${pair}→${idA}`, gateA);
    heads.set(`${pair}→${idB}`, gateB);
    pairGates.set(pair, [
      translate(gateA.hit, a.offset[0], a.offset[1]),
      translate(gateB.hit, b.offset[0], b.offset[1]),
    ]);
  }

  const gateRequests = new Map<string, GateRequest[]>();
  const requestFor = (cityId: string, key: string, nodeId: string, gate: Bridgehead) => {
    const list = gateRequests.get(cityId);
    const req = { key, nodeId, gate };
    if (list) {
      list.push(req);
    } else {
      gateRequests.set(cityId, [req]);
    }
  };
  for (const key of [...interLinks.keys()].sort()) {
    const link = interLinks.get(key)!;
    const pair = pairKey(link);
    const gateFrom = heads.get(`${pair}→${link.fromCityId}`);
    const gateTo = heads.get(`${pair}→${link.toCityId}`);
    if (!gateFrom || !gateTo) {
      continue;
    }
    requestFor(link.fromCityId, key, link.fromNodeId, gateFrom);
    requestFor(link.toCityId, key, link.toNodeId, gateTo);
  }

  return { pairGates, gateRequests };
}

interface LocalCity {
  cityId: string;
  biome: BiomeId;
  layout: CityNodesLayout;
  /** Kept around: roads are only routed once the bridgeheads are known. */
  intraLinks: ResolvedLink[];
  outline: Vec2[];
  /** The ring road, mutated as bridgeheads and driveways attach to it. */
  ring: Vec2[];
  /** The corner lattice inside the ring, shared by the bridgeheads and the streets. */
  grid: Grid;
  groups: GroupZone[];
  discoveredZone?: GroupZone;
  /** Enclosing radius around the local origin — what the island placement collides on. */
  radius: number;
  /** Ingress services held out of the layout until `planHarbours` gives them a berth. */
  ports: ResolvedNode[];
  /** Which of them came from telemetry rather than the static graph. */
  discoveredPorts: ReadonlySet<string>;
  /** Filled in by `planHarbours`, in local coordinates. */
  harbour?: HarbourSite;
}

function buildLocalCity(
  cityId: string,
  staticNodes: ResolvedNode[],
  links: ResolvedLink[],
  discoveredNodes: DiscoveredResolvedNode[],
  biome: BiomeId,
  ingress: ReadonlySet<string>,
): LocalCity {
  const intraLinks = links.filter((l) => !l.interCity && l.fromCityId === cityId);
  const statics = staticNodes.filter((n) => n.cityId === cityId);
  const discoveredOwn = discoveredNodes.filter((n) => n.cityId === cityId);
  const own = [...statics, ...discoveredOwn];
  // The shore and the ring are offsets of the hull of what stays in the block:
  // a city made only of ingress services has no hull to put a coast on, so the
  // last one keeps its plot and the island stays portless.
  const ports = own
    .filter((n) => ingress.has(`${cityId}/${n.id}`))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, Math.max(0, own.length - 1));
  const portIds = new Set(ports.map((n) => n.id));
  const layout = layoutCity(cityId, statics, discoveredOwn, intraLinks, portIds);
  // The coast is the biome's business: its own salt, so the shore does not move with the buildings' seed.
  const outline = islandOutline(layout.nodes, {
    seed: fnv1a(`${cityId}|shore`),
    ruggedness: BIOMES[biome].ruggedness,
  });
  const { ring, inner } = buildRing(layout.nodes);
  const grid = makeGrid(layout.cells, inner);
  let radius = ISLAND_PADDING;
  for (const p of outline) {
    radius = Math.max(radius, Math.hypot(p[0], p[1]));
  }
  if (ports.length > 0) {
    radius += HARBOUR_REACH;
  }

  const discovered = layout.nodes.filter((n) => n.isDiscovered);
  return {
    cityId,
    biome,
    layout,
    intraLinks,
    outline,
    ring,
    grid,
    groups: buildGroups(layout.nodes),
    ...(discovered.length > 0
      ? {
          discoveredZone: {
            name: "discovered",
            outline: zoneOutline(footprintCorners(discovered), DISCOVERY_PADDING),
            center: centroid(discovered.map((n) => [n.position[0], n.position[2]] as Vec2)),
          },
        }
      : {}),
    radius,
    ports,
    discoveredPorts: new Set(discoveredOwn.filter((n) => portIds.has(n.id)).map((n) => n.id)),
  };
}

/**
 * Puts every island's ingress services back on its shore, as its port.
 *
 * Runs after `placeIslands`, because a berth is only worth having if a ship can
 * reach it: the sea lanes are tested in world coordinates against every shore.
 * The site comes back in local coordinates and the berths are plain lattice
 * cells, so the nodes rejoin `layout.cells` like any other building and
 * `buildRoadNetwork` serves them through its existing "no link, straight out to
 * the ring" path — no road code knows a port exists.
 */
function planHarbours(locals: LocalCity[], offsets: Vec2[]): void {
  const islands = locals.map((l, i) =>
    l.outline.map((p) => translate(p, offsets[i]![0], offsets[i]![1])),
  );
  locals.forEach((local, i) => {
    if (local.ports.length === 0) {
      return;
    }
    const site = planHarbour({
      cityId: local.cityId,
      outline: local.outline,
      ring: local.ring,
      taken: new Set([...local.layout.cells.values()].map(cellKey)),
      ingress: local.ports.map((n) => ({ nodeId: n.id, address: `${local.cityId}/${n.id}` })),
      offset: offsets[i]!,
      islands,
    });
    if (!site) {
      return;
    }
    local.harbour = site;
    const byId = new Map(local.ports.map((n) => [n.id, n] as const));
    for (const berth of site.berths) {
      const node = byId.get(berth.nodeId);
      if (!node) {
        continue;
      }
      local.layout.cells.set(node.id, berth.cell);
      local.layout.nodes.push({
        ...node,
        position: [berth.position[0], 0, berth.position[1]],
        isPort: true,
        ...(local.discoveredPorts.has(node.id) ? { isDiscovered: true } : {}),
      });
    }
  });
}

/** One zone per neighbourhood, in alphabetical order. */
function buildGroups(nodes: PositionedNode[]): GroupZone[] {
  const byGroup = new Map<string, PositionedNode[]>();
  for (const n of nodes) {
    if (!n.group) {
      continue;
    }
    const members = byGroup.get(n.group);
    if (members) {
      members.push(n);
    } else {
      byGroup.set(n.group, [n]);
    }
  }
  return [...byGroup.keys()].sort().map((name) => {
    const members = byGroup.get(name)!;
    return {
      name,
      outline: zoneOutline(footprintCorners(members), GROUP_PADDING),
      center: centroid(members.map((n) => [n.position[0], n.position[2]] as Vec2)),
    };
  });
}

/**
 * Relaxes the islands as discs: springs for linked pairs, hard `WATER_GAP`
 * separation, then integer offsets recentred on the origin.
 */
function placeIslands(locals: LocalCity[], links: ResolvedLink[]): Vec2[] {
  if (locals.length === 0) {
    return [];
  }
  const indexOf = new Map(locals.map((l, i) => [l.cityId, i]));
  const avgRadius = locals.reduce((s, l) => s + l.radius, 0) / locals.length;
  const spacing = avgRadius * 2 + WATER_GAP;
  const bodies: Body[] = locals.map((l, i) => {
    const r = spacing * Math.sqrt(i + 0.5);
    const a = (i + 0.5) * GOLDEN_ANGLE;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, r: l.radius };
  });

  const weights = new Map<string, number>();
  for (const l of links) {
    if (!l.interCity) {
      continue;
    }
    const a = indexOf.get(l.fromCityId);
    const b = indexOf.get(l.toCityId);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const springs: Spring[] = [...weights.keys()].sort().map((key) => {
    const [a, b] = key.split(":").map(Number) as [number, number];
    return {
      a,
      b,
      rest: locals[a]!.radius + locals[b]!.radius + WATER_GAP,
      k: Math.min(weights.get(key) ?? 1, 3),
    };
  });

  relax(bodies, springs, {
    iterations: FORCE_ITERATIONS,
    springK: 0.25,
    repelK: 0.4,
    repelPadding: WATER_GAP,
    centerK: 0.01,
    collisionMargin: WATER_GAP,
  });

  const offsets: Vec2[] = bodies.map((b) => [Math.round(b.x), Math.round(b.z)]);
  const mid = centroid(offsets);
  const cx = Math.round(mid[0]);
  const cz = Math.round(mid[1]);
  return offsets.map(([x, z]) => [x - cx, z - cz] as Vec2);
}

function translate(p: Vec2, dx: number, dz: number): Vec2 {
  return [p[0] + dx, p[1] + dz];
}

function translateZone(zone: GroupZone, dx: number, dz: number): GroupZone {
  return {
    name: zone.name,
    outline: zone.outline.map((p) => translate(p, dx, dz)),
    center: translate(zone.center, dx, dz),
  };
}

function translateRoads(roads: RoadNetwork, dx: number, dz: number): RoadNetwork {
  const routes = new Map(
    [...roads.routes].map(([key, route]) => [
      key,
      { points: route.points.map((p) => translate(p, dx, dz)) },
    ]),
  );
  return {
    segments: roads.segments.map((s) => ({
      ...s,
      points: s.points.map((p) => translate(p, dx, dz)),
    })),
    roundabouts: roads.roundabouts.map((r) => ({ ...r, center: translate(r.center, dx, dz) })),
    driveways: roads.driveways.map((d) => ({
      ...d,
      mouth: translate(d.mouth, dx, dz),
      door: translate(d.door, dx, dz),
    })),
    ring: roads.ring.map((p) => translate(p, dx, dz)),
    routes,
  };
}
