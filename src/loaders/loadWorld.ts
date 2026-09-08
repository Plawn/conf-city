import { BIOME_IDS, isBiomeId } from "../domain/biome";
import type { ResolvedLink, ResolvedNode, World } from "../domain/types";

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

/** Structural check: does the JSON look like a World? */
export function isWorldShape(json: unknown): json is World {
  if (!json || typeof json !== "object") {
    return false;
  }
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.cities)) {
    return false;
  }
  return obj.cities.every(
    (c: unknown) =>
      c !== null &&
      typeof c === "object" &&
      typeof (c as Record<string, unknown>).id === "string" &&
      Array.isArray((c as Record<string, unknown>).nodes),
  );
}

function validate(world: World) {
  const errors: string[] = [];
  const cityIds = new Set<string>();

  // Check duplicate city IDs
  for (const city of world.cities) {
    if (cityIds.has(city.id)) {
      errors.push(`Duplicate city ID: "${city.id}"`);
    }
    cityIds.add(city.id);
    if (city.biome !== undefined && !isBiomeId(city.biome)) {
      errors.push(
        `Unknown biome "${String(city.biome)}" in city "${city.id}" (expected one of ${BIOME_IDS.join(", ")})`,
      );
    }

    // Check duplicate node IDs within city
    const nodeIds = new Set<string>();
    for (const node of city.nodes) {
      if (nodeIds.has(node.id)) {
        errors.push(`Duplicate node ID "${node.id}" in city "${city.id}"`);
      }
      nodeIds.add(node.id);
      if (node.ingress !== undefined && typeof node.ingress !== "boolean") {
        errors.push(`Node "${node.id}" ingress must be a boolean`);
      }
    }

    // Check intra-city link targets exist
    for (const node of city.nodes) {
      for (const target of node.links) {
        if (!nodeIds.has(target)) {
          errors.push(`Node "${node.id}" in city "${city.id}" links to unknown node "${target}"`);
        }
      }
    }
  }

  // Check inter-city links
  if (world.links) {
    for (const link of world.links) {
      for (const ref of [link.from, link.to]) {
        const parts = ref.split("/");
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          errors.push(`Invalid inter-city link format: "${ref}" (expected "cityId/nodeId")`);
          continue;
        }
        const [cId, nId] = parts;
        const city = world.cities.find((c) => c.id === cId);
        if (!city) {
          errors.push(`Inter-city link references unknown city: "${cId}"`);
        } else if (!city.nodes.find((n) => n.id === nId)) {
          errors.push(`Inter-city link references unknown node "${nId}" in city "${cId}"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new GraphValidationError(`Graph validation failed:\n- ${errors.join("\n- ")}`);
  }
}

export function loadWorld(world: World) {
  validate(world);

  const nodes: ResolvedNode[] = [];
  const links: ResolvedLink[] = [];

  // Intra-city links
  for (const city of world.cities) {
    for (const node of city.nodes) {
      nodes.push({ ...node, cityId: city.id });

      for (const target of node.links) {
        links.push({
          fromNodeId: node.id,
          fromCityId: city.id,
          toNodeId: target,
          toCityId: city.id,
          interCity: false,
        });
      }
    }
  }

  // Inter-city links (format: "cityId/nodeId")
  if (world.links) {
    for (const link of world.links) {
      const [fromCityId, fromNodeId] = link.from.split("/");
      const [toCityId, toNodeId] = link.to.split("/");

      if (fromCityId && fromNodeId && toCityId && toNodeId) {
        links.push({
          fromNodeId,
          fromCityId,
          toNodeId,
          toCityId,
          interCity: true,
          label: link.label,
        });
      }
    }
  }

  return { nodes, links };
}
