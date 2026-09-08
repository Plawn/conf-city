import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "ok" | "warn" | "danger" | "muted" | "accent" | "info";

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: "bg-ok/15 text-ok border-ok/40",
  warn: "bg-warn/15 text-warn border-warn/40",
  danger: "bg-danger/15 text-danger border-danger/40",
  muted: "bg-white/5 text-surface-400 border-white/10",
  accent: "bg-accent-500/20 text-accent-200 border-accent-400/40",
  info: "bg-sky-400/15 text-sky-300 border-sky-400/40",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Render as a toggleable chip (dimmed when not active). */
  active?: boolean;
  dot?: boolean;
  children?: ReactNode;
}

export function Badge({
  tone = "muted",
  active = true,
  dot,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wide leading-4 whitespace-nowrap",
        TONE_CLASS[tone],
        !active && "opacity-35 grayscale",
        rest.onClick && "cursor-pointer select-none",
        className,
      )}
      {...rest}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
