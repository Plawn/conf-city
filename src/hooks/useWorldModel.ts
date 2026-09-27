import { useEffect, useMemo } from "react";
import { resolveBiomes } from "../domain/biome";
import { nodeAddress } from "../domain/nodeStyle";
import type {
  City,
  CityMeta,
  GraphNode,
  NodeMeta,
  NodeTelemetry,
  ResolvedNode,
  World,
} from "../domain/types";
import { layoutWorld } from "../layout/layoutWorld";
import { buildDiscoveredNodes } from "../loaders/buildDiscoveredNodes";
import { GraphValidationError, loadWorld } from "../loaders/loadWorld";
import { worldIdentity } from "../sim/traffic/worldRoutes";
import { useMobilityStore } from "../store/mobilityStore";
import { useUiStore } from "../store/uiStore";

/** The loaded world merged with discovery and laid out: every memo keeps its original dependencies. */
export function useWorldModel(
  world: World,
  {
    rawTelemetry,
    nodeMeta,
    cityMeta,
    telemetryKeysVersion,
  }: {
    rawTelemetry: Map<string, NodeTelemetry>;
    nodeMeta: Map<string, NodeMeta>;
    cityMeta: Map<string, CityMeta>;
    telemetryKeysVersion: number;
  },
) {
  const pushToast = useUiStore((s) => s.pushToast);

  const {
    nodes: staticNodes,
    links: staticLinks,
    error: worldError,
  } = useMemo(() => {
    try {
      const loaded = loadWorld(world);
      return { nodes: loaded.nodes, links: loaded.links, error: null as string | null };
    } catch (e) {
      const error = e instanceof GraphValidationError ? e.message : String(e);
      return { nodes: [] as ResolvedNode[], links: [], error };
    }
  }, [world]);

  useEffect(() => {
    if (worldError) {
      pushToast({
        tone: "danger",
        title: "Invalid world",
        message: worldError,
        durationMs: 10_000,
      });
    }
  }, [worldError, pushToast]);

  // Telemetry without provider-hidden nodes (agents, exporters…): drives counts, alerts and the scene.
  const telemetry = useMemo(() => {
    let hasHidden = false;
    for (const m of nodeMeta.values()) {
      if (m.hidden) {
        hasHidden = true;
        break;
      }
    }
    if (!hasHidden) {
      return rawTelemetry;
    }
    const out = new Map(rawTelemetry);
    for (const [addr, m] of nodeMeta) {
      if (m.hidden) {
        out.delete(addr);
      }
    }
    return out;
  }, [rawTelemetry, nodeMeta]);

  const knownAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const city of world.cities) {
      for (const node of city.nodes) {
        set.add(`${city.id}/${node.id}`);
      }
    }
    return set;
  }, [world]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the version changes only when telemetry keys change; depending on the Map would relayout on every metric tick.
  const { discoveredNodes, discoveredCities, discoveredLinks } = useMemo(() => {
    const result = buildDiscoveredNodes(
      new Set(telemetry.keys()),
      knownAddresses,
      world.cities,
      nodeMeta,
    );
    return {
      discoveredNodes: result.nodes,
      discoveredCities: result.cities,
      discoveredLinks: result.links,
    };
  }, [telemetryKeysVersion, knownAddresses, nodeMeta, world.cities]);

  const links = useMemo(() => [...staticLinks, ...discoveredLinks], [staticLinks, discoveredLinks]);

  const allCities: City[] = useMemo(
    () => [
      ...world.cities,
      ...discoveredCities.map((dc) => ({
        id: dc.id,
        name: dc.name,
        description: "Auto-discovered",
        nodes: [] as GraphNode[],
      })),
    ],
    [world.cities, discoveredCities],
  );

  // Biomes move with the same inputs as the layout (node keys, city meta), so
  // resolving them here costs no extra re-layout — and `layoutWorld` shapes each
  // shore with its biome, so it has to know before it lays anything out.
  const biomes = useMemo(
    () => resolveBiomes(allCities, [...staticNodes, ...discoveredNodes], cityMeta),
    [allCities, staticNodes, discoveredNodes, cityMeta],
  );

  // Machine memory sizes each island; `cityMeta` already feeds the biomes, so no extra re-layout.
  const capacities = useMemo(() => {
    const out = new Map<string, number>();
    for (const [id, m] of cityMeta) {
      if (m.memMb != null && m.memMb > 0) {
        out.set(id, m.memMb);
      }
    }
    return out;
  }, [cityMeta]);

  // Identity of the loaded world: the key the mobility store (and its ingress
  // overrides) is scoped by. Computed once here, handed down to `WorldScene`.
  const worldKey = useMemo(() => worldIdentity(world), [world]);
  const ingressOverrides = useMobilityStore((s) => s.ingress);

  // An ingress service *is* the island's port: it must be known before anything
  // is laid out, since `layoutWorld` holds those nodes out of the footprint hull
  // and puts them back on the shoreline (see `layout/harbour.ts`). Priority:
  // the UI checkbox, then the provider label, then the JSON.
  const ingressAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const n of [...staticNodes, ...discoveredNodes]) {
      const addr = nodeAddress(n);
      const override = ingressOverrides[`${worldKey}:${addr}`];
      if (override ?? nodeMeta.get(addr)?.ingress ?? n.ingress ?? false) {
        set.add(addr);
      }
    }
    return set;
  }, [staticNodes, discoveredNodes, ingressOverrides, worldKey, nodeMeta]);

  const worldLayout = useMemo(
    () =>
      layoutWorld(
        allCities.map((c) => c.id),
        staticNodes,
        links,
        discoveredNodes,
        biomes,
        ingressAddresses,
        capacities,
      ),
    [allCities, staticNodes, links, discoveredNodes, biomes, ingressAddresses, capacities],
  );
  const nodes = worldLayout.nodes;
  const nodeByAddr = useMemo(() => new Map(nodes.map((n) => [nodeAddress(n), n])), [nodes]);

  return {
    telemetry,
    discoveredCities,
    links,
    allCities,
    worldKey,
    worldLayout,
    nodes,
    nodeByAddr,
  };
}
