import { Sparkline } from "./Sparkline";
import { GlassCard } from "./ui";

export function MetricCard({
  label,
  value,
  unit,
  series,
  color = "#7aa7ff",
  min,
  max,
}: {
  label: string;
  value: number | undefined;
  unit?: string;
  series: (number | undefined)[];
  color?: string;
  min?: number;
  max?: number;
}) {
  return (
    <GlassCard className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-surface-400">
          {label}
        </span>
        <span className="font-mono text-[13px] font-semibold">
          {value == null ? <span className="text-surface-500">—</span> : value}
          {value != null && unit && (
            <span className="ml-0.5 text-[10px] font-normal text-surface-400">{unit}</span>
          )}
        </span>
      </div>
      <Sparkline values={series} width={140} height={30} color={color} min={min} max={max} />
    </GlassCard>
  );
}
