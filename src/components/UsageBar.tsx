import { heatColor } from "../domain/metrics";
import { cx } from "./ui";

/**
 * Horizontal usage bar: `value` vs `max` (limit). Colour follows the
 * green → orange → red ramp; a missing max renders a neutral bar.
 */
export function UsageBar({
  label,
  value,
  max,
  format,
  className,
  onClick,
}: {
  label: React.ReactNode;
  value: number;
  max?: number;
  format: (v: number) => string;
  className?: string;
  onClick?: () => void;
}) {
  const ratio = max && max > 0 ? value / max : undefined;
  const width = ratio != null ? Math.min(ratio, 1) * 100 : 0;
  const color = ratio != null ? heatColor(ratio) : "#7aa7ff";
  const content = (
    <>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate text-surface-200">{label}</span>
        <span className="shrink-0 font-mono text-surface-300">
          {format(value)}
          {max ? <span className="text-surface-500"> / {format(max)}</span> : null}
          {ratio != null && (
            <span className="ml-1.5" style={{ color }}>
              {Math.round(ratio * 100)}%
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${width}%`, background: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cx(
          "-mx-1 flex cursor-pointer flex-col gap-1 rounded-md px-1 py-0.5 text-left hover:bg-white/5",
          className,
        )}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return <div className={cx("flex flex-col gap-1", className)}>{content}</div>;
}
