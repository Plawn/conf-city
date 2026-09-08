import type { ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";

export function Drawer({
  open,
  onClose,
  title,
  width = 360,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  width?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-hidden={!open}
      style={{ width }}
      className={cx(
        "glass-morphic-thick absolute right-4 top-4 bottom-4 z-40 flex flex-col rounded-2xl text-[13px] text-white transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "translate-x-[calc(100%+2rem)] pointer-events-none",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="min-w-0 flex-1">{title}</div>
        <Button iconOnly aria-label="Close" onClick={onClose} title="Close (Esc)">
          <CloseIcon />
        </Button>
      </header>
      <div className="glass-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </aside>
  );
}

export function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M3 3l8 8M11 3l-8 8" />
    </svg>
  );
}
