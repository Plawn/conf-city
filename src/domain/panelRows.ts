import { type BiomeId, type BiomeSource, biomeSource } from "./biome";
import { type CityUsage, cityUsage } from "./metrics/cityUsage";
import { rankValue } from "./metrics/format";
import { cpuSaturation, memSaturation } from "./metrics/saturation";
import { nodeAddress } from "./nodeStyle";
import type { City, CityMeta, CityMetrics, NodeTelemetry, PositionedNode } from "./types";
import type { ViewMode } from "./viewMode";

/** Rows of the Cities and Top consumers panels, derived from the positioned world and telemetry. */

export interface CityRow {
  city: City;
  count: number;
  isDiscovered: boolean;
  /** liveness summary for this city */
  down: number;
  degraded: number;
  usage?: CityUsage;
  /** The island's biome and where it came from (JSON, provider label, or deduced). */
  biome?: { id: BiomeId; source: BiomeSource };
}

export interface ConsumerRow {
  addr: string;
  label: string;
  cityId: string;
  value: number;
  /** 0..1 relative to the top consumer of the same city */
  ratio: number;
  /** saturation vs limit when known */
  saturation?: number;
}

/** One row per city: node count, liveness summary, usage and resolved biome. */
export function cityRows(
  allCities: City[],
  nodes: PositionedNode[],
  telemetry: Map<string, NodeTelemetry>,
  cityMeta: Map<string, CityMeta>,
  cityMetrics: Map<string, CityMetrics>,
  discoveredCities: { id: string }[],
  layoutCities: ReadonlyMap<string, { biome?: BiomeId }>,
): CityRow[] {
  return allCities.map((city) => {
    const cityNodes = nodes.filter((n) => n.cityId === city.id);
    let down = 0,
      degraded = 0;
    const cityTelemetry = cityNodes.map((n) => telemetry.get(nodeAddress(n)));
    for (const t of cityTelemetry) {
      if (t?.liveness === "down") {
        down++;
      } else if (t?.liveness === "degraded") {
        degraded++;
      }
    }
    const usage = cityTelemetry.some(Boolean)
      ? cityUsage(cityTelemetry, cityMeta.get(city.id), cityMetrics.get(city.id))
      : undefined;
    const biome = layoutCities.get(city.id)?.biome;
    return {
      city,
      count: cityNodes.length,
      isDiscovered: discoveredCities.some((dc) => dc.id === city.id),
      down,
      degraded,
      usage,
      ...(biome ? { biome: { id: biome, source: biomeSource(city, cityMeta.get(city.id)) } } : {}),
    };
  });
}

// Top consumers for the active metric (health → memory), normalised per city
export function topConsumers(
  nodes: PositionedNode[],
  telemetry: Map<string, NodeTelemetry>,
  visibleCities: Set<string>,
  viewMode: ViewMode,
): ConsumerRow[] {
  const mode = viewMode === "health" ? "memory" : viewMode;
  const cityMaxValue = new Map<string, number>();
  const rows: ConsumerRow[] = [];
  for (const n of nodes) {
    if (!visibleCities.has(n.cityId)) {
      continue;
    }
    const m = telemetry.get(nodeAddress(n))?.metrics;
    const value = rankValue(mode, m);
    if (value == null) {
      continue;
    }
    cityMaxValue.set(n.cityId, Math.max(cityMaxValue.get(n.cityId) ?? 0, value));
    const saturation =
      mode === "cpu"
        ? m?.cpuLimit
          ? cpuSaturation(m)
          : undefined
        : mode === "memory"
          ? memSaturation(m)
          : undefined;
    rows.push({
      addr: nodeAddress(n),
      label: n.label,
      cityId: n.cityId,
      value,
      ratio: 0,
      saturation,
    });
  }
  rows.sort((a, b) => b.value - a.value);
  return rows.slice(0, 5).map((r) => ({
    ...r,
    ratio: (cityMaxValue.get(r.cityId) ?? 0) > 0 ? r.value / cityMaxValue.get(r.cityId)! : 0,
  }));
}
