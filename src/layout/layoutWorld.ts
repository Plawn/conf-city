import { type BiomeId, DEFAULT_BIOME } from "../domain/biome";
import type {
  DiscoveredResolvedNode,
  PositionedNode,
  ResolvedLink,
  ResolvedNode,
} from "../domain/types";
import { buildBridges } from "./bridges";
import { centroid, polygonBounds } from "./geometry";
import { translateHarbour } from "./harbour";
import { placeIslands, planGates } from "./islands";
import { buildLocalCity, planHarbours } from "./localCity";
import { buildRoadNetwork } from "./roads/network";
import { translate, translateRoads, translateZone } from "./translate";
import type { CityLayout, Vec2, WorldLayout } from "./types";
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
      ...(local.crowding != null ? { crowding: local.crowding } : {}),
      ...(local.packed ? { packed: true } : {}),
      nodes: cityNodes,
      center: centroid(outline),
      outline,
      ...(local.land ? { land: local.land.map((p) => translate(p, dx, dz)) } : {}),
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
