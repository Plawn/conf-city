import { type BiomeId, DEFAULT_BIOME } from "../domain/biome";
import type {
  DiscoveredResolvedNode,
  PositionedNode,
  ResolvedLink,
  ResolvedNode,
} from "../domain/types";
import { buildBridges, pairKey } from "./bridges";
import { centroid, polygonBounds } from "./geometry";
import { translateHarbour } from "./harbour";
import { placeIslands, planGates } from "./islands";
import { buildGroups, buildLocalCity, type LocalCity, planHarbours } from "./localCity";
import type { GateRequest } from "./roads/bridgehead";
import { buildRoadNetwork } from "./roads/network";
import { translate, translateRoads, translateZone } from "./translate";
import { type CityLayout, linkKey, type UtilityPlot, type Vec2, type WorldLayout } from "./types";
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
): WorldLayout {
  return assembleWorld(
    planWorld(cityIds, staticNodes, links, discoveredNodes, biomes, ingress, capacities),
  );
}

/** Everything fixed before the streets: buildings, shores, island offsets, harbours, bridgeheads. */
export interface WorldPlan {
  locals: LocalCity[];
  offsets: Vec2[];
  links: ResolvedLink[];
  pairGates: Map<string, [Vec2, Vec2]>;
  gateRequests: Map<string, GateRequest[]>;
}

export function planWorld(
  cityIds: string[],
  staticNodes: ResolvedNode[],
  links: ResolvedLink[],
  discoveredNodes: DiscoveredResolvedNode[] = [],
  biomes: ReadonlyMap<string, BiomeId> = new Map(),
  ingress: ReadonlySet<string> = new Set(),
  capacities: ReadonlyMap<string, number> = new Map(),
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
      capacities.get(cityId),
    ),
  );
  const offsets = placeIslands(locals, links);
  planHarbours(locals, offsets);
  // Bridgeheads first: the feeder streets to them are part of the road network,
  // so roads can only be routed once the islands know who faces whom.
  const { pairGates, gateRequests } = planGates(locals, offsets, links);
  return { locals, offsets, links, pairGates, gateRequests };
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
    // A copy: attaching driveways inserts vertices, and the plan is assembled again and again.
    const roads = buildRoadNetwork(nodesLayout, intraLinks, gates, {
      ring: [...local.ring],
      grid: local.grid,
    });
    // After the roads: the plot is chosen against the streets that were actually
    // drawn, and against the bridgeheads already attached to the ring.
    const worldPlot = active?.plots?.get(local.cityId);
    const plot = active?.plots?.has(local.cityId)
      ? undefined
      : placeUtilityPlot({
          cityId: local.cityId,
          outline: local.outline,
          ring: roads.ring.length > 0 ? roads.ring : local.ring,
          roads,
          buildings: nodesLayout.nodes.map((n) => [n.position[0], n.position[2]] as Vec2),
          gates: gates.map((r) => r.gate.hit),
        });
    const cityNodes = nodesLayout.nodes.map((n) => ({
      ...n,
      position: [n.position[0] + dx, n.position[1], n.position[2] + dz] as [number, number, number],
    }));
    const outline = local.outline.map((p) => translate(p, dx, dz));
    const groups = active ? buildGroups(nodesLayout.nodes) : local.groups;
    const layout: CityLayout = {
      cityId: local.cityId,
      biome: local.biome,
      ...(local.crowding != null ? { crowding: local.crowding } : {}),
      ...(local.packed ? { packed: true } : {}),
      nodes: cityNodes,
      center: centroid(outline),
      outline,
      ...(local.land ? { land: local.land.map((p) => translate(p, dx, dz)) } : {}),
      bounds: polygonBounds(outline) ?? { cx: dx, cz: dz, width: 4, height: 4 },
      roads: translateRoads(roads, dx, dz),
      groups: groups.map((g) => translateZone(g, dx, dz)),
      ...(local.discoveredZone
        ? { discoveredZone: translateZone(local.discoveredZone, dx, dz) }
        : {}),
      ...(local.harbour ? { harbour: translateHarbour(local.harbour, dx, dz) } : {}),
      ...(worldPlot ? { utilityPlot: worldPlot } : {}),
      ...(plot ? { utilityPlot: translateUtilityPlot(plot, dx, dz) } : {}),
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
  return { nodes, cities, bridges: buildBridges(cities, links, pairGates) };
}
