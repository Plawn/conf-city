import { create } from "zustand";
import type { CameraTarget } from "../domain/camera";
import {
  isQualityChoice,
  type QualityChoice,
  type QualityProfile,
  type QualityTier,
} from "../domain/quality";
import {
  effectiveProfile,
  hasOverrides,
  normalizeOverrides,
  parseTweaks,
  type QualityOverrides,
} from "../domain/qualityOverrides";
import type { ViewMode } from "../domain/viewMode";

export type ToastTone = "ok" | "warn" | "danger" | "info";

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

const TWEAKS_KEY = "conf-city-tweaks";

/** `?tweaks=` wins at load (and is not stored, so an empty value loads clean); otherwise remembered. */
function savedOverrides(): QualityOverrides {
  try {
    if (typeof window === "undefined") {
      return {};
    }
    const forced = new URLSearchParams(window.location.search).get("tweaks");
    if (forced !== null) {
      return parseTweaks(forced);
    }
    const stored = localStorage.getItem(TWEAKS_KEY);
    return stored ? normalizeOverrides(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

function persistOverrides(overrides: QualityOverrides) {
  try {
    if (hasOverrides(overrides)) {
      localStorage.setItem(TWEAKS_KEY, JSON.stringify(overrides));
    } else {
      localStorage.removeItem(TWEAKS_KEY);
    }
  } catch {
    // Rendering still works in browsers that disallow local storage.
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
  /** User "Tweaks" applied on top of the tier's budgets; persisted. */
  renderOverrides: QualityOverrides;
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
  setRenderOverride: <K extends keyof QualityOverrides>(
    key: K,
    value: QualityOverrides[K] | undefined,
  ) => void;
  resetRenderOverrides: () => void;
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
  renderOverrides: savedOverrides(),
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
  setRenderOverride: (key, value) =>
    set((s) => {
      const renderOverrides = { ...s.renderOverrides };
      if (value === undefined) {
        delete renderOverrides[key];
      } else {
        renderOverrides[key] = value;
      }
      persistOverrides(renderOverrides);
      return { renderOverrides };
    }),
  resetRenderOverrides: () => {
    persistOverrides({});
    set({ renderOverrides: {} });
  },
  setIdle: (idle) => set({ idle }),
}));

/** Tier in effect: the manual choice, or whatever the governor settled on. */
export const selectTier = (s: Pick<UiState, "quality" | "autoTier">): QualityTier =>
  s.quality === "auto" ? s.autoTier : s.quality;

export function useQualityTier(): QualityTier {
  return useUiStore(selectTier);
}

let cachedProfile: {
  tier: QualityTier;
  overrides: QualityOverrides;
  profile: QualityProfile;
} | null = null;

/** Tier merged with the tweaks; one-entry cache so the identity is stable for `Object.is`. */
export const selectProfile = (
  s: Pick<UiState, "quality" | "autoTier" | "renderOverrides">,
): QualityProfile => {
  const tier = selectTier(s);
  if (cachedProfile?.tier !== tier || cachedProfile.overrides !== s.renderOverrides) {
    cachedProfile = {
      tier,
      overrides: s.renderOverrides,
      profile: effectiveProfile(tier, s.renderOverrides),
    };
  }
  return cachedProfile.profile;
};

/** Every render budget is read here: the tier's profile with the user's tweaks on top. */
export function useQualityProfile(): QualityProfile {
  return useUiStore(selectProfile);
}
