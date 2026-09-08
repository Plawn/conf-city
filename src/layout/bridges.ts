import type { ResolvedLink } from "../domain/types";
import { type Bridge, type BridgeCrossing, type CityLayout, linkKey, type Vec2 } from "./types";

/** `"cityA|cityB"`, cities in lexical order — the identity of a bridge. */
export function pairKey(l: ResolvedLink): string {
  return l.fromCityId < l.toCityId
    ? `${l.fromCityId}|${l.toCityId}`
    : `${l.toCityId}|${l.fromCityId}`;
}

/**
 * Assembles the bridges from parts computed upstream: one deck per pair of
 * linked cities (`gates`, world coords, bridgehead on each shore), and one
 * crossing per link, stitched from the feeder routes `buildRoadNetwork` stored
 * under the link's key in each city's road network.
 *
 * A crossing whose feeder could not be routed (node missing from the lattice)
 * falls back to a straight leg between the building and its bridgehead.
 */
export function buildBridges(
  cities: Map<string, CityLayout>,
  links: ResolvedLink[],
  gates: Map<string, [Vec2, Vec2]>,
): Bridge[] {
  const positions = new Map<string, Vec2>();
  for (const city of cities.values()) {
    for (const n of city.nodes) {
      positions.set(`${n.cityId}/${n.id}`, [n.position[0], n.position[2]]);
    }
  }

  const byPair = new Map<string, { link: ResolvedLink; key: string }[]>();
  const seen = new Set<string>();
  for (const link of links) {
    if (!link.interCity) {
      continue;
    }
    if (!cities.has(link.fromCityId) || !cities.has(link.toCityId)) {
      continue;
    }
    const key = linkKey(link);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const pair = pairKey(link);
    const group = byPair.get(pair);
    if (group) {
      group.push({ link, key });
    } else {
      byPair.set(pair, [{ link, key }]);
    }
  }

  const bridges: Bridge[] = [];
  for (const pair of [...byPair.keys()].sort()) {
    const gate = gates.get(pair);
    if (!gate) {
      continue;
    }
    const [cityA, cityB] = pair.split("|") as [string, string];

    const crossings: BridgeCrossing[] = [];
    for (const { link, key } of byPair.get(pair)!.sort((a, b) => a.key.localeCompare(b.key))) {
      // `gate` is ordered by the pair key; flip it to the direction of travel.
      const [gateFrom, gateTo] = link.fromCityId === cityA ? gate : [gate[1], gate[0]];
      const from = positions.get(`${link.fromCityId}/${link.fromNodeId}`);
      const to = positions.get(`${link.toCityId}/${link.toNodeId}`);
      const feederFrom =
        cities.get(link.fromCityId)!.roads.routes.get(key)?.points ??
        (from ? [from, gateFrom] : [gateFrom]);
      const feederTo =
        cities.get(link.toCityId)!.roads.routes.get(key)?.points ?? (to ? [to, gateTo] : [gateTo]);
      crossings.push({
        link,
        key,
        points: [...feederFrom, ...[...feederTo].reverse()],
        waterSpan: [gateFrom, gateTo],
      });
    }

    bridges.push({ key: pair, cityA, cityB, waterSpan: gate, crossings });
  }
  return bridges;
}
