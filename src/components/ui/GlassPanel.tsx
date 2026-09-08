import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Variant = "default" | "thick" | "subtle";

const VARIANT_CLASS: Record<Variant, string> = {
  default: "glass-morphic",
  thick: "glass-morphic-thick",
  subtle: "glass-morphic-subtle",
};

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  padding?: "none" | "sm" | "md";
  children?: ReactNode;
}

/** Floating glass container. Position it with Tailwind (`absolute top-4 left-4`). */
export function GlassPanel({
  variant = "default",
  padding = "md",
  className,
  children,
  ...rest
}: GlassPanelProps) {
  return (
    <div
      className={cx(
        VARIANT_CLASS[variant],
        "rounded-2xl text-[13px] text-white",
        padding === "md" && "px-4 py-3",
        padding === "sm" && "px-3 py-2",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Smaller-radius glass surface for nested cards / tooltips. */
export function GlassCard({ className, ...rest }: GlassPanelProps) {
  return (
    <GlassPanel variant="subtle" padding="sm" className={cx("rounded-xl", className)} {...rest} />
  );
}
