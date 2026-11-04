import { useMemo } from "react";
import { resolveBiomes } from "../domain/biome";
import { planShots, type ShotKey } from "../domain/director";
import { nodeAddress } from "../domain/nodeStyle";
import type { Timeline } from "../domain/scenario";
import type { City, NodeTelemetry, ResolvedLink } from "../domain/types";
import { type ActiveSet, assembleWorld, planWorld } from "../layout/layoutWorld";
import { linkKey, type WorldLayout } from "../layout/types";
import { loadWorld } from "../loaders/loadWorld";
import { worldIdentity } from "../sim/traffic/worldRoutes";

export interface ReplayBase {
  worldKey: string;
  /** Everything that ever existed, laid out once: the director frames on it. */
  full: WorldLayout;
  shots: ShotKey[];
  assemble: (active: ActiveSet) => WorldLayout;
}

/** The union is planned once; every instant is an assembly of it, so nothing ever moves. */
export function useReplayBase(tl: Timeline): ReplayBase {
  return useMemo(() => {
    const { nodes } = loadWorld(tl.world);
    const biomes = resolveBiomes(tl.world.cities, nodes, tl.cityMeta);
    const capacities = new Map<string, number>();
    for (const [id, m] of tl.cityMeta) {
      if (m.memMb != null && m.memMb > 0) {
        capacities.set(id, m.memMb);
      }
    }
    const ingress = new Set(nodes.filter((n) => n.ingress).map(nodeAddress));
    const clouds = new Set(tl.world.cities.filter((c) => c.cloud).map((c) => c.id));
    const plan = planWorld(
      tl.world.cities.map((c) => c.id),
      nodes,
      tl.links,
      [],
      biomes,
      ingress,
      capacities,
      clouds,
    );
    const full = assembleWorld(plan);
    const plots = new Map([...full.cities].map(([id, c]) => [id, c.utilityPlot]));
    return {
      worldKey: worldIdentity(tl.world),
      full,
      shots: planShots(tl, full),
      assemble: (active) => assembleWorld(plan, { ...active, plots }),
    };
  }, [tl]);
}

/** Inverse of `activeKey`: ids never hold `,` or `|`. */
export function parseActiveKey(key: string): ActiveSet & { cities: Set<string> } {
  const [cities = "", nodes = "", links = ""] = key.split("|");
  const set = (s: string) => new Set(s ? s.split(",") : []);
  return { cities: set(cities), nodes: set(nodes), links: set(links) };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** What the scene shows for one active set: stable objects per address so memoised meshes skip. */
export function useReplayScene(tl: Timeline, base: ReplayBase, key: string) {
  const telemetryCache = useMemo(() => new Map<string, NodeTelemetry>(), []);
  return useMemo(() => {
    const active = parseActiveKey(key);
    const layout = base.assemble(active);
    const cities: City[] = tl.world.cities.filter((c) => active.cities.has(c.id));
    const links: ResolvedLink[] = tl.links.filter((l) => active.links.has(linkKey(l)));
    const telemetry = new Map<string, NodeTelemetry>();
    for (const addr of active.nodes) {
      let entry: NodeTelemetry | undefined = telemetryCache.get(addr);
      if (!entry) {
        // Steady, seeded load, never stale: enough traffic to bring the roads to life, no incidents.
        entry = {
          liveness: "healthy",
          metrics: { rps: 4 + (hash(addr) % 24) },
          lastSeen: Number.MAX_SAFE_INTEGER,
        };
        telemetryCache.set(addr, entry);
      }
      telemetry.set(addr, entry);
    }
    let clouds = 0;
    for (const id of active.cities) {
      if (base.full.cities.get(id)?.cloud) {
        clouds++;
      }
    }
    return {
      layout,
      cities,
      links,
      telemetry,
      visibleCities: active.cities,
      counts: {
        cities: active.cities.size - clouds,
        clouds,
        nodes: active.nodes.size,
      },
    };
  }, [tl, base, key, telemetryCache]);
}
