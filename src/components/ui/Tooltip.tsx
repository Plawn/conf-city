import type { ReactNode } from "react";
import { cx } from "./cx";

/** CSS-only hover tooltip. Wrap any inline element. */
export function Tooltip({
  label,
  side = "bottom",
  children,
  className,
}: {
  label: ReactNode;
  side?: "top" | "bottom";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("group relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cx(
          "glass-tooltip pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-black/80 px-2 py-1 text-[11px] font-normal normal-case tracking-normal text-white opacity-0 shadow-lg backdrop-blur-md transition-opacity group-hover:opacity-100",
          side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
        )}
      >
        {label}
      </span>
    </span>
  );
}
