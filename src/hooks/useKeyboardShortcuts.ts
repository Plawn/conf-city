import { useEffect } from "react";

export interface ShortcutHandlers {
  onSearch?: () => void;
  onEscape?: () => void;
  onReset?: () => void;
  onFit?: () => void;
  onToggleLogs?: () => void;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/** Global single-key shortcuts: `/` search, Esc, R reset, F fit, L logs. */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.key === "Escape") {
        handlers.onEscape?.();
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
        }
        return;
      }
      if (isTypingTarget(e.target)) {
        return;
      }
      switch (e.key) {
        case "/":
          e.preventDefault();
          handlers.onSearch?.();
          break;
        case "r":
        case "R":
          handlers.onReset?.();
          break;
        case "f":
        case "F":
          handlers.onFit?.();
          break;
        case "l":
        case "L":
          handlers.onToggleLogs?.();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
