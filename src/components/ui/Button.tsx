import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Variant = "glass" | "ghost" | "primary" | "danger";
type Size = "xs" | "sm" | "md";

const VARIANT_CLASS: Record<Variant, string> = {
  glass: "glass-button",
  ghost:
    "bg-transparent text-surface-300 hover:text-white hover:bg-white/10 border border-transparent",
  primary:
    "bg-accent-500/80 hover:bg-accent-400/90 text-white border border-accent-300/40 shadow-[0_2px_10px_var(--glass-accent-30)]",
  danger: "bg-danger/70 hover:bg-danger/90 text-white border border-white/10",
};

const SIZE_CLASS: Record<Size, string> = {
  xs: "text-[10px] px-2 py-0.5 rounded-md",
  sm: "text-[12px] px-2.5 py-1 rounded-lg",
  md: "text-[13px] px-3.5 py-1.5 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  iconOnly?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "glass",
  size = "sm",
  iconOnly,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-1.5 font-medium cursor-pointer select-none transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-400",
        iconOnly ? "glass-icon-btn" : VARIANT_CLASS[variant],
        !iconOnly && SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
