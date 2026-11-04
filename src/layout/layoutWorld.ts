import { type BiomeId, DEFAULT_BIOME } from "../domain/biome";
import type {
  DiscoveredResolvedNode,
  PositionedNode,
  ResolvedLink,
  ResolvedNode,
} from "../domain/types";
import { buildBridges, pairKey } from "./bridges";
import { buildCableways } from "./cableway";
import { cityAltitude, cloudOutline } from "./cloud";
import { centroid, polygonBounds } from "./geometry";
import { translateHarbour } from "./harbour";
import { placeIslands, planGates } from "./islands";
import { buildGroups, buildLocalCity, type LocalCity, planHarbours } from "./localCity";
import type { GateRequest } from "./roads/bridgehead";
import { buildRoadNetwork } from "./roads/network";
import { translate, translateRoads, translateZone } from "./translate";
import {
  type CityLayout,
  linkKey,
  type RoadNetwork,
  type UtilityPlot,
  type Vec2,
  type WorldLayout,
} from "./types";
import { placeUtilityPlot, translateUtilityPlot } from "./utilityPlot";

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
 *
 * `capacities` holds each machine's memory (MB): the island grows to the land it
 * buys (`capacityRadius`), so a small machine carrying a big city reads as crowded.
 */
export function layoutWorld(
  cityIds: string[],
  staticNodes: ResolvedNode[],
  links: ResolvedLink[],
  discoveredNodes: DiscoveredResolvedNode[] = [],
  biomes: ReadonlyMap<string, BiomeId> = new Map(),
  ingress: ReadonlySet<string> = new Set(),
  capacities: ReadonlyMap<string, number> = new Map(),
  clouds: ReadonlySet<string> = new Set(),
): WorldLayout {
  return assembleWorld(
    planWorld(cityIds, staticNodes, links, discoveredNodes, biomes, ingress, capacities, clouds),
  );
}

/** Everything fixed before the streets: buildings, shores, island offsets, harbours, bridgeheads. */
export interface WorldPlan {
  locals: LocalCity[];
  offsets: Vec2[];
  links: ResolvedLink[];
  pairGates: Map<string, [Vec2, Vec2]>;
  gateRequests: Map<string, GateRequest[]>;
  /**
   * Cloud services: placed like islands, but never given a bridgehead. Their deck,
   * in world coordinates, sized once from the full plan so it never resizes or rebuilds.
   */
  clouds: ReadonlyMap<string, { outline: Vec2[]; center: Vec2 }>;
}

/** A cloud service carries no streets. */
const NO_ROADS: RoadNetwork = {
  segments: [],
  roundabouts: [],
  driveways: [],
  ring: [],
  routes: new Map(),
};

export function planWorld(
  cityIds: string[],
  staticNodes: ResolvedNode[],
  links: ResolvedLink[],
  discoveredNodes: DiscoveredResolvedNode[] = [],
  biomes: ReadonlyMap<string, BiomeId> = new Map(),
  ingress: ReadonlySet<string> = new Set(),
  capacities: ReadonlyMap<string, number> = new Map(),
  clouds: ReadonlySet<string> = new Set(),
): WorldPlan {
  const ids = [...new Set(cityIds)];
  const locals = ids.map((cityId) =>
    buildLocalCity(
      cityId,
      staticNodes,
      links,
      discoveredNodes,
      biomes.get(cityId) ?? DEFAULT_BIOME,
      ingress,
      // A managed service has no machine to size: its cloud fits what it carries.
      clouds.has(cityId) ? undefined : capacities.get(cityId),
    ),
  );
  const offsets = placeIslands(locals, links);
  planHarbours(locals, offsets);
  // Bridgeheads first: the feeder streets to them are part of the road network,
  // so roads can only be routed once the islands know who faces whom.
  // Links still pull a cloud next to its users, but no bridge climbs to the sky.
  const grounded = links.filter(
    (l) => !l.interCity || (!clouds.has(l.fromCityId) && !clouds.has(l.toCityId)),
  );
  const { pairGates, gateRequests } = planGates(locals, offsets, grounded);
  const decks = new Map<string, { outline: Vec2[]; center: Vec2 }>();
  locals.forEach((local, i) => {
    if (clouds.has(local.cityId)) {
      const [dx, dz] = offsets[i]!;
      const outline = cloudOutline(local.layout.nodes).map((p) => translate(p, dx, dz));
      decks.set(local.cityId, { outline, center: centroid(outline) });
    }
  });
  return { locals, offsets, links, pairGates, gateRequests, clouds: decks };
}

/**
 * A subset of a plan, for the replay: positions stay those of the full plan
 * (no float round-trip), streets and bridges are routed for the active links only.
 */
export interface ActiveSet {
  cities: ReadonlySet<string>;
  /** `cityId/nodeId`. */
  nodes: ReadonlySet<string>;
  /** `linkKey`. */
  links: ReadonlySet<string>;
  /** Utility plots of the full assembly, so the lighthouse never moves as the city grows. */
  plots?: ReadonlyMap<string, UtilityPlot | undefined>;
}

export function assembleWorld(plan: WorldPlan, active?: ActiveSet): WorldLayout {
  const links = active ? plan.links.filter((l) => active.links.has(linkKey(l))) : plan.links;
  const cities = new Map<string, CityLayout>();
  const nodes: PositionedNode[] = [];
  plan.locals.forEach((local, i) => {
    if (active && !active.cities.has(local.cityId)) {
      return;
    }
    const [dx, dz] = plan.offsets[i]!;
    const keep = (id: string) => !active || active.nodes.has(`${local.cityId}/${id}`);
    const nodesLayout = active
      ? {
          nodes: local.layout.nodes.filter((n) => keep(n.id)),
          cells: new Map([...local.layout.cells].filter(([id]) => keep(id))),
        }
      : local.layout;
    const intraLinks = active
      ? local.intraLinks.filter((l) => active.links.has(linkKey(l)))
      : local.intraLinks;
    const gates = (plan.gateRequests.get(local.cityId) ?? []).filter(
      (r) => !active || active.links.has(r.key),
    );
    const deck = plan.clouds.get(local.cityId);
    const cloud = deck !== undefined;
    // A copy: attaching driveways inserts vertices, and the plan is assembled again and again.
    const roads = cloud
      ? NO_ROADS
      : buildRoadNetwork(nodesLayout, intraLinks, gates, {
          ring: [...local.ring],
          grid: local.grid,
        });
    // After the roads: the plot is chosen against the streets that were actually
    // drawn, and against the bridgeheads already attached to the ring.
    const worldPlot = active?.plots?.get(local.cityId);
    const plot =
      cloud || active?.plots?.has(local.cityId)
        ? undefined
        : placeUtilityPlot({
            cityId: local.cityId,
            outline: local.outline,
            ring: roads.ring.length > 0 ? roads.ring : local.ring,
            roads,
            buildings: nodesLayout.nodes.map((n) => [n.position[0], n.position[2]] as Vec2),
            gates: gates.map((r) => r.gate.hit),
          });
    // World y is the deck's altitude: cameras and effects aim at a cloud's buildings, not the sea.
    const y = cityAltitude({ cloud });
    const cityNodes = nodesLayout.nodes.map((n) => ({
      ...n,
      position: [n.position[0] + dx, y, n.position[2] + dz] as [number, number, number],
    }));
    const outline = deck?.outline ?? local.outline.map((p) => translate(p, dx, dz));
    const groups = cloud ? [] : active ? buildGroups(nodesLayout.nodes) : local.groups;
    const layout: CityLayout = {
      cityId: local.cityId,
      biome: local.biome,
      ...(local.crowding != null ? { crowding: local.crowding } : {}),
      ...(local.packed ? { packed: true } : {}),
      nodes: cityNodes,
      center: deck?.center ?? centroid(outline),
      outline,
      ...(local.land ? { land: local.land.map((p) => translate(p, dx, dz)) } : {}),
      bounds: polygonBounds(outline) ?? { cx: dx, cz: dz, width: 4, height: 4 },
      roads: cloud ? NO_ROADS : translateRoads(roads, dx, dz),
      groups: groups.map((g) => translateZone(g, dx, dz)),
      ...(local.discoveredZone
        ? { discoveredZone: translateZone(local.discoveredZone, dx, dz) }
        : {}),
      ...(local.harbour ? { harbour: translateHarbour(local.harbour, dx, dz) } : {}),
      ...(worldPlot ? { utilityPlot: worldPlot } : {}),
      ...(plot ? { utilityPlot: translateUtilityPlot(plot, dx, dz) } : {}),
      ...(cloud ? { cloud: true as const } : {}),
    };
    cities.set(local.cityId, layout);
    nodes.push(...cityNodes);
  });

  const pairGates = active
    ? new Map(
        [...plan.pairGates].filter(([pair]) =>
          links.some((l) => l.interCity && pairKey(l) === pair),
        ),
      )
    : plan.pairGates;
  return {
    nodes,
    cities,
    bridges: buildBridges(cities, links, pairGates),
    cableways: buildCableways(cities, links),
  };
}
