import { useEffect } from "react";
import { type Toast as ToastData, type ToastTone, useUiStore } from "../../store/uiStore";
import { cx } from "./cx";
import { CloseIcon } from "./Drawer";

const TONE_BAR: Record<ToastTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-accent-400",
};

const DEFAULT_DURATION = 6000;

function ToastItem({ toast, onClick }: { toast: ToastData; onClick?: (t: ToastData) => void }) {
  const dismiss = useUiStore((s) => s.dismissToast);
  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), toast.durationMs ?? DEFAULT_DURATION);
    return () => clearTimeout(id);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div
      role="status"
      onClick={() => onClick?.(toast)}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && onClick && toast.node) {
          event.preventDefault();
          onClick(toast);
        }
      }}
      tabIndex={onClick && toast.node ? 0 : undefined}
      className={cx(
        "glass-morphic animate-toast-in relative flex w-[300px] items-start gap-3 overflow-hidden rounded-xl px-3 py-2.5 text-[12px] text-white shadow-lg",
        onClick && toast.node && "cursor-pointer hover:brightness-125",
      )}
    >
      <span className={cx("absolute left-0 top-0 h-full w-1", TONE_BAR[toast.tone])} />
      <div className="min-w-0 flex-1 pl-1">
        <div className="truncate font-semibold">{toast.title}</div>
        {toast.message && <div className="mt-0.5 text-surface-300">{toast.message}</div>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="glass-icon-btn shrink-0 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          dismiss(toast.id);
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** Mount once. Renders toasts from the UI store, stacked bottom-center. */
export function ToastHost({ onToastClick }: { onToastClick?: (t: ToastData) => void }) {
  const toasts = useUiStore((s) => s.toasts);
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-50 flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onClick={onToastClick} />
        </div>
      ))}
    </div>
  );
}
