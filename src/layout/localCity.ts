import { BIOMES, type BiomeId } from "../domain/biome";
import type {
  DiscoveredResolvedNode,
  PositionedNode,
  ResolvedLink,
  ResolvedNode,
} from "../domain/types";
import { fnv1a } from "../lib/random";
import { DISCOVERY_PADDING, GROUP_PADDING, HARBOUR_REACH, ISLAND_PADDING } from "./constants";
import { cellKey, centroid } from "./geometry";
import { type HarbourSite, planHarbour } from "./harbour";
import { type CityNodesLayout, layoutCity } from "./layoutCity";
import { footprintCorners, islandShore, zoneOutline } from "./outline";
import { buildRing } from "./ringRoad";
import { type Grid, makeGrid } from "./roads/lattice";
import { translate } from "./translate";
import type { GroupZone, Vec2 } from "./types";

export interface LocalCity {
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
  /** Land the buildings need over the land the machine's memory buys (`islandShore`). */
  crowding?: number;
  /** Laid out dense because the loose layout overflowed the memory's land. */
  packed?: boolean;
  /** Natural ground of an overbuilt island; `outline` minus this is landfill. */
  land?: Vec2[];
  /** Enclosing radius around the local origin — what the island placement collides on. */
  radius: number;
  /** Ingress services held out of the layout until `planHarbours` gives them a berth. */
  ports: ResolvedNode[];
  /** Which of them came from telemetry rather than the static graph. */
  discoveredPorts: ReadonlySet<string>;
  /** Filled in by `planHarbours`, in local coordinates. */
  harbour?: HarbourSite;
}

export function buildLocalCity(
  cityId: string,
  staticNodes: ResolvedNode[],
  links: ResolvedLink[],
  discoveredNodes: DiscoveredResolvedNode[],
  biome: BiomeId,
  ingress: ReadonlySet<string>,
  capacityMb?: number,
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
  // The coast is the biome's business: its own salt, so the shore does not move with the buildings' seed.
  const shape = { seed: fnv1a(`${cityId}|shore`), ruggedness: BIOMES[biome].ruggedness };
  let layout = layoutCity(cityId, statics, discoveredOwn, intraLinks, portIds);
  let shore = islandShore(layout.nodes, shape, capacityMb);
  // More services than the memory buys land for: pack them street to street.
  const packed = (shore.crowding ?? 0) > 1;
  if (packed) {
    layout = layoutCity(cityId, statics, discoveredOwn, intraLinks, portIds, true);
    shore = islandShore(layout.nodes, shape, capacityMb);
  }
  const { outline, crowding, land } = shore;
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
    ...(crowding != null ? { crowding } : {}),
    ...(packed ? { packed } : {}),
    ...(land ? { land } : {}),
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
export function planHarbours(locals: LocalCity[], offsets: Vec2[]): void {
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
