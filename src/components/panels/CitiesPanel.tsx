import { BIOMES, type BiomeId, type BiomeSource } from "../../domain/biome";
import { type CityUsage, usageTooltip } from "../../domain/metrics/cityUsage";
import { formatMbPerSec, saturationTone } from "../../domain/metrics/format";
import type { City } from "../../domain/types";
import { Badge, Tooltip } from "../ui";

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

const BIOME_SOURCE_LABEL: Record<BiomeSource, string> = {
  json: "set in the world JSON",
  label: "set by the provider (node label)",
  auto: "deduced from the content",
};

export function CitiesPanel({
  rows,
  visibleCities,
  onToggle,
  onFocus,
}: {
  rows: CityRow[];
  visibleCities: Set<string>;
  onToggle: (cityId: string) => void;
  onFocus: (cityId: string) => void;
}) {
  return (
    <div>
      <div className="heading mb-2">Cities</div>
      {rows.map(({ city, count, isDiscovered, down, degraded, usage, biome }) => (
        <div key={city.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
          <input
            type="checkbox"
            aria-label={`Show ${city.name}`}
            className="cursor-pointer accent-accent-400"
            checked={visibleCities.has(city.id)}
            onChange={() => onToggle(city.id)}
          />
          <Tooltip label="Click to zoom" className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => onFocus(city.id)}
              className={`flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate bg-transparent text-left ${isDiscovered ? "text-ok" : ""}`}
            >
              <span className="truncate">{city.name}</span>
              {isDiscovered && <span className="text-[9px] text-ok/80">discovered</span>}
              {biome && (
                <span
                  className="text-[9px] text-muted"
                  title={`Biome: ${BIOMES[biome.id].label} — ${BIOME_SOURCE_LABEL[biome.source]}`}
                >
                  · {biome.id}
                </span>
              )}
            </button>
          </Tooltip>
          {down > 0 && <Badge tone="danger">{down}</Badge>}
          {degraded > 0 && <Badge tone="warn">{degraded}</Badge>}
          <Badge tone="muted">{count}</Badge>
          {(usage?.cpuPct != null || usage?.memPct != null || usage?.diskPct != null) && (
            <div className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-6 text-[10px] text-surface-500">
              {usage.cpuPct != null && (
                <Tooltip label={usageTooltip(usage, "cpu")}>
                  <span className="flex items-center gap-1">
                    CPU{" "}
                    <Badge tone={saturationTone(usage.cpuPct / 100)}>
                      {Math.round(usage.cpuPct)}%
                    </Badge>
                  </span>
                </Tooltip>
              )}
              {usage.memPct != null && (
                <Tooltip label={usageTooltip(usage, "mem")}>
                  <span className="flex items-center gap-1">
                    Mem{" "}
                    <Badge tone={saturationTone(usage.memPct / 100)}>
                      {Math.round(usage.memPct)}%
                    </Badge>
                  </span>
                </Tooltip>
              )}
              {usage.diskPct != null && (
                <Tooltip label={usageTooltip(usage, "disk")}>
                  <span className="flex items-center gap-1">
                    Disk{" "}
                    <Badge tone={saturationTone(usage.diskPct / 100)}>
                      {Math.round(usage.diskPct)}%
                    </Badge>
                  </span>
                </Tooltip>
              )}
              {/* Without a host measurement these are only the services, i.e. a floor. */}
              {!usage.fromHost && <span className="text-surface-600">services</span>}
              {(usage.diskReadMbPerSec != null || usage.diskWriteMbPerSec != null) && (
                <span className="w-full text-surface-600">
                  {`I/O ↓ ${formatMbPerSec(usage.diskReadMbPerSec ?? 0)} ↑ ${formatMbPerSec(usage.diskWriteMbPerSec ?? 0)}`}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
