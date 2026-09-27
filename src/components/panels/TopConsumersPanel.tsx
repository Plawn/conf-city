import { formatRank, heatColor as heat, RANK_LABEL } from "../../domain/metrics/format";
import type { ViewMode } from "../../domain/viewMode";
import { useUiStore } from "../../store/uiStore";
import { SegmentedControl } from "../ui";

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

const MODES: { value: ViewMode; label: string }[] = [
  { value: "memory", label: "Mem" },
  { value: "cpu", label: "CPU" },
  { value: "network", label: "Net" },
];

/** Top-N consumers for the active metric; click → select the building. */
export function TopConsumersPanel({
  rows,
  onPick,
}: {
  rows: ConsumerRow[];
  onPick: (addr: string) => void;
}) {
  const mode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const rankMode: ViewMode = mode === "health" ? "memory" : mode;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="heading" title={`Top 5 ${RANK_LABEL[rankMode].toLowerCase()} consumers`}>
          Top 5
        </div>
        <SegmentedControl
          options={MODES}
          value={rankMode}
          onChange={setViewMode}
          className="!text-[10px] [&>button]:!px-2 [&>button]:!py-0.5"
        />
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-surface-500">No telemetry yet.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const color = r.saturation != null ? heat(r.saturation) : "#7aa7ff";
            return (
              <button
                key={r.addr}
                type="button"
                onClick={() => onPick(r.addr)}
                className="-mx-1 flex cursor-pointer flex-col gap-0.5 rounded-md px-1 py-0.5 text-left hover:bg-white/5"
                title={r.addr}
              >
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate text-surface-200">
                    {r.label} <span className="text-surface-500">· {r.cityId}</span>
                  </span>
                  <span className="shrink-0 font-mono text-surface-300">
                    {formatRank(rankMode, r.value)}
                    {r.saturation != null && (
                      <span className="ml-1" style={{ color }}>
                        {Math.round(r.saturation * 100)}%
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${Math.round(r.ratio * 100)}%`, background: color }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
