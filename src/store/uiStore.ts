import { create } from "zustand";
import type { CameraTarget } from "../domain/camera";
import {
  isQualityChoice,
  QUALITY_PROFILES,
  type QualityChoice,
  type QualityTier,
} from "../domain/quality";

export type ToastTone = "ok" | "warn" | "danger" | "info";

/** What the buildings encode: health colours, or a heatmap of one resource. */
export type ViewMode = "health" | "cpu" | "memory" | "network";
export type RenderMode = "office" | "smooth";

function savedRenderMode(): RenderMode {
  try {
    return typeof window !== "undefined" &&
      localStorage.getItem("conf-city-render-mode") === "smooth"
      ? "smooth"
      : "office";
  } catch {
    return "office";
  }
}

/** `?quality=` wins at load so measurements can force a tier; the choice is otherwise remembered. */
function savedQuality(): QualityChoice {
  try {
    if (typeof window === "undefined") {
      return "auto";
    }
    const forced = new URLSearchParams(window.location.search).get("quality");
    if (isQualityChoice(forced)) {
      return forced;
    }
    const stored = localStorage.getItem("conf-city-quality");
    return isQualityChoice(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  /** Node address to select when the toast is clicked. */
  node?: string;
  durationMs?: number;
}

interface UiState {
  selectedNode: string | null;
  cameraTarget: CameraTarget | null;
  logPanel: { open: boolean; nodeFilter: string };
  toasts: Toast[];
  viewMode: ViewMode;
  renderMode: RenderMode;
  /** Requested rendering quality: a fixed tier, or "auto" for adapter detection plus the governor. */
  quality: QualityChoice;
  /** Tier the governor currently applies in "auto" mode. */
  autoTier: QualityTier;
  /** Window unfocused or pointer inactive: the automatic display drops to the idle cadence. */
  idle: boolean;

  select: (addr: string | null) => void;
  setCamera: (target: CameraTarget | null) => void;
  setLogPanelOpen: (open: boolean) => void;
  setLogNodeFilter: (nodeFilter: string) => void;
  openLogsFor: (addr: string) => void;
  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setRenderMode: (mode: RenderMode) => void;
  setQuality: (quality: QualityChoice) => void;
  setAutoTier: (tier: QualityTier) => void;
  setIdle: (idle: boolean) => void;
}

let toastSeq = 0;
const MAX_TOASTS = 5;

export const useUiStore = create<UiState>((set) => ({
  selectedNode: null,
  cameraTarget: null,
  logPanel: { open: false, nodeFilter: "" },
  toasts: [],
  viewMode: "health",
  renderMode: savedRenderMode(),
  quality: savedQuality(),
  autoTier: "balanced",
  idle: false,

  select: (addr) => set({ selectedNode: addr }),
  setCamera: (target) => set({ cameraTarget: target }),
  setLogPanelOpen: (open) => set((s) => ({ logPanel: { ...s.logPanel, open } })),
  setLogNodeFilter: (nodeFilter) => set((s) => ({ logPanel: { ...s.logPanel, nodeFilter } })),
  openLogsFor: (addr) => set({ logPanel: { open: true, nodeFilter: addr } }),
  pushToast: (toast) =>
    set((s) => ({
      toasts: [...s.toasts, { ...toast, id: `t${++toastSeq}` }].slice(-MAX_TOASTS),
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setViewMode: (viewMode) => set({ viewMode }),
  setRenderMode: (renderMode) => {
    try {
      localStorage.setItem("conf-city-render-mode", renderMode);
    } catch {
      // Rendering still works in browsers that disallow local storage.
    }
    set({ renderMode });
  },
  setQuality: (quality) => {
    try {
      localStorage.setItem("conf-city-quality", quality);
    } catch {
      // Rendering still works in browsers that disallow local storage.
    }
    set({ quality });
  },
  setAutoTier: (autoTier) => set({ autoTier }),
  setIdle: (idle) => set({ idle }),
}));

/** Tier in effect: the manual choice, or whatever the governor settled on. */
export const selectTier = (s: Pick<UiState, "quality" | "autoTier">): QualityTier =>
  s.quality === "auto" ? s.autoTier : s.quality;

export function useQualityTier(): QualityTier {
  return useUiStore(selectTier);
}

export function useQualityProfile() {
  return QUALITY_PROFILES[useQualityTier()];
}
