import { useCallback, useMemo, useRef, useState } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { initialTier } from "../domain/quality";
import { useUiStore } from "../store/uiStore";
import { createRenderer, gpuRenderer, isWebGPU, rendererDeviceInfo } from "./lighting/renderer";
import { cachedInitializer } from "./lighting/rendererInitialization";
import { createLightingRuntime } from "./lighting/runtime";

/** Device-lost recovery: each loss remounts a new renderer generation (WebGL from the second), keeping the camera. */
export function useRendererRecovery() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [rendererAttempt, setRendererAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: GPU resources belong to one renderer generation.
  const lighting = useMemo(() => createLightingRuntime(), [rendererAttempt]);
  const savedCamera = useRef<{
    position: [number, number, number];
    target: [number, number, number];
  } | null>(null);
  const handleDeviceLost = useCallback(() => {
    const controls = controlsRef.current;
    if (controls) {
      savedCamera.current = {
        position: controls.object.position.toArray(),
        target: controls.target.toArray(),
      };
    }
    setRendererAttempt((attempt) => Math.min(3, attempt + 1));
  }, []);
  const initializeRenderer = useMemo(() => {
    const initialize = cachedInitializer(async (canvas: HTMLCanvasElement) => {
      const gl = await createRenderer(canvas, rendererAttempt >= 2, handleDeviceLost);
      // Pick the starting tier before any child mounts, so budgets are right on first draw.
      const renderer = gpuRenderer(gl);
      useUiStore.getState().setAutoTier(
        initialTier({
          backend: isWebGPU(renderer) ? "webgpu" : "webgl",
          ...rendererDeviceInfo(renderer),
          cores: navigator.hardwareConcurrency,
        }),
      );
      return gl;
    });
    return (defaults: { canvas: unknown }) => initialize(defaults.canvas as HTMLCanvasElement);
  }, [rendererAttempt, handleDeviceLost]);
  return {
    controlsRef,
    rendererAttempt,
    setRendererAttempt,
    lighting,
    savedCamera,
    initializeRenderer,
  };
}
