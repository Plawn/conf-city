import { addAfterEffect, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  createGovernor,
  frameBudgetMs,
  type GovernorChange,
  isIdle,
  resolveDpr,
  stepTier,
} from "../domain/quality";
import { useQualityProfile, useUiStore } from "../store/uiStore";
import { renderParams } from "./lighting/renderer";

/** Every tier change decided this session, for the perf HUD and headless checks. */
export const qualityHistory: GovernorChange[] = [];

/** `?idle=0` keeps an automatic display at full cadence, e.g. for unattended benchmarks. */
const IDLE_ENABLED = renderParams.get("idle") !== "0";
const IDLE_CHECK_MS = 1000;
const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"] as const;

/**
 * Render scale from the effective pixel budget (tier plus tweaks) and the canvas
 * size, handed to the Canvas `dpr` prop (a `setDpr` alone is reset by the next Canvas render).
 * Only a budget or layout change touches it: ClusteredLighting rebuilds its buffers on resize.
 */
export function RenderScale({ onDpr }: { onDpr: (dpr: number) => void }) {
  // Destructured so a tweak to another budget never re-runs the resize.
  const { maxPixels, maxDpr } = useQualityProfile();
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  useEffect(() => {
    onDpr(resolveDpr({ maxPixels, maxDpr }, width, height, window.devicePixelRatio));
  }, [maxPixels, maxDpr, width, height, onDpr]);
  return null;
}

/**
 * In "auto" quality: steps the tier from measured frame intervals, and drops
 * the cadence when the window is unfocused or the pointer has been idle. A
 * manual tier disables both, so a wall display is never throttled.
 */
export function QualityGovernor() {
  const quality = useUiStore((s) => s.quality);
  const renderMode = useUiStore((s) => s.renderMode);
  const setAutoTier = useUiStore((s) => s.setAutoTier);
  const setIdle = useUiStore((s) => s.setIdle);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  // One governor per canvas: its ceiling and probe history outlive mode switches.
  const governor = useMemo(() => {
    const state = useUiStore.getState();
    return createGovernor({
      budgetMs: frameBudgetMs(state.renderMode === "office" ? 30 : 60),
      initial: state.autoTier,
      ceiling: stepTier(state.autoTier, 1),
      now: performance.now(),
    });
  }, []);
  useEffect(() => {
    governor.setBudget(frameBudgetMs(renderMode === "office" ? 30 : 60));
  }, [governor, renderMode]);
  useEffect(() => {
    // Resizes rebuild targets and pipelines; the frames around them are not evidence.
    if (width > 0 && height > 0) {
      governor.reset();
    }
  }, [governor, width, height]);
  useEffect(() => {
    if (quality !== "auto") {
      return;
    }
    let previous = 0;
    return addAfterEffect(() => {
      const now = performance.now();
      const interval = previous ? now - previous : 0;
      previous = now;
      const next = governor.observe(now, interval, useUiStore.getState().idle);
      if (next) {
        qualityHistory.push(governor.changes.at(-1)!);
        setAutoTier(next);
      }
    });
  }, [governor, quality, setAutoTier]);

  useEffect(() => {
    if (quality !== "auto" || !IDLE_ENABLED) {
      setIdle(false);
      return;
    }
    let lastActivity = performance.now();
    let focused = document.hasFocus();
    const update = () => {
      const idle = isIdle(performance.now(), lastActivity, focused && !document.hidden);
      if (idle !== useUiStore.getState().idle) {
        setIdle(idle);
      }
    };
    const activity = () => {
      lastActivity = performance.now();
      if (useUiStore.getState().idle) {
        update();
      }
    };
    const focus = () => {
      focused = true;
      activity();
      update();
    };
    const blur = () => {
      focused = false;
      update();
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, activity, { passive: true, capture: true });
    }
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, IDLE_CHECK_MS);
    update();
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, activity, { capture: true });
      }
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", update);
      window.clearInterval(timer);
      setIdle(false);
    };
  }, [quality, setIdle]);
  return null;
}
