import type {
  City,
  DiscoveredResolvedNode,
  NodeMeta,
  NodeType,
  ResolvedLink,
} from "../domain/types";

export interface DiscoveredCity {
  id: string;
  name: string;
}

function isValidNodeType(t: string | undefined): t is NodeType {
  return t === "app" || t === "db" || t === "cache" || t === "queue";
}

function splitAddress(addr: string): [string, string] | null {
  const slash = addr.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return [addr.slice(0, slash), addr.slice(slash + 1)];
}

/**
 * Resolve telemetry addresses that have no matching node in the static world
 * JSON into (unpositioned) nodes, plus any new city IDs. Positions are
 * assigned later by `layoutWorld`.
 *
 * Provider metadata drives type / label / group / description / `ingress`,
 * `hidden` nodes are dropped, and `meta.links` (full addresses) become `ResolvedLink`s —
 * intra-city ones also feed `node.links` so the layered layout can use them.
 */
export function buildDiscoveredNodes(
  telemetryKeys: Set<string>,
  knownAddresses: Set<string>,
  existingCities: City[],
  nodeMeta: Map<string, NodeMeta>,
): { nodes: DiscoveredResolvedNode[]; cities: DiscoveredCity[]; links: ResolvedLink[] } {
  const existingCityIds = new Set(existingCities.map((c) => c.id));
  const nodes: DiscoveredResolvedNode[] = [];
  const newCities: DiscoveredCity[] = [];
  const links: ResolvedLink[] = [];
  const seenCities = new Set<string>();
  const visible = new Set<string>();
  for (const addr of telemetryKeys) {
    if (!nodeMeta.get(addr)?.hidden) {
      visible.add(addr);
    }
  }
  for (const addr of knownAddresses) {
    visible.add(addr);
  }

  for (const addr of [...telemetryKeys].sort()) {
    if (knownAddresses.has(addr)) {
      continue;
    }
    const parts = splitAddress(addr);
    if (!parts) {
      continue;
    }
    const [cityId, nodeId] = parts;
    const meta = nodeMeta.get(addr);
    if (meta?.hidden) {
      continue;
    }
    if (!existingCityIds.has(cityId) && !seenCities.has(cityId)) {
      seenCities.add(cityId);
      newCities.push({ id: cityId, name: cityId });
    }
    const intraLinks: string[] = [];
    for (const target of meta?.links ?? []) {
      if (target === addr || !visible.has(target)) {
        continue;
      }
      const t = splitAddress(target);
      if (!t) {
        continue;
      }
      const interCity = t[0] !== cityId;
      if (!interCity) {
        intraLinks.push(t[1]);
      }
      links.push({
        fromCityId: cityId,
        fromNodeId: nodeId,
        toCityId: t[0],
        toNodeId: t[1],
        interCity,
        inferred: meta?.linksInferred,
      });
    }
    nodes.push({
      id: nodeId,
      cityId,
      type: isValidNodeType(meta?.type) ? meta.type : "app",
      label: meta?.label ?? nodeId,
      description: meta?.description,
      group: meta?.group,
      ...(meta?.ingress ? { ingress: true } : {}),
      links: intraLinks,
      isDiscovered: true,
    });
  }

  return { nodes, cities: newCities, links };
}
