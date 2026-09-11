import { addAfterEffect, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { GovernorChange, QualityChoice, QualityTier } from "../domain/quality";
import { selectTier, useUiStore } from "../store/uiStore";
import type { inspectBuildings } from "./buildings/instances";
import { ActiveClusteredLighting } from "./lighting/ActiveClusteredLighting";
import { gpuRenderer, isWebGPU, rendererDeviceInfo, renderParams } from "./lighting/renderer";
import { useLighting } from "./lighting/runtime";
import { qualityHistory } from "./QualityGovernor";

export interface LightingGpuSample {
  id: number;
  requestedAt: number;
  resolvedAt: number;
  renderMs: number;
  computeMs: number;
  gpuMs: number;
}

export interface LightingPerfSample {
  time: number;
  intervalMs: number;
  cpuMs: number;
  gpuMs: number | null;
  /** Latest asynchronously resolved observation, not a GPU duration for this frame. */
  gpuSampleId: number | null;
  volumePasses: number;
  volumeBlurPasses: number;
  buildingAnimationVisits: number;
  buildingInstanceWrites: number;
  sunShadowRenders: number;
  beaconShadowRenders: number;
  clusterDispatches: number;
  clusteredPointLightVisits: number;
  draws: number;
  triangles: number;
  textures: number;
  bytes: number;
}

declare global {
  interface Window {
    __CITY_RENDER__?: {
      capture: () => Promise<string>;
      simulateDeviceLoss: () => void;
      focus: (position: [number, number, number], target: [number, number, number]) => void;
      inspect: () => {
        buildings: ReturnType<typeof inspectBuildings>;
        altitude: number;
        night: number;
        camera: number[];
        target?: number[];
        activeLights: number;
        beacon: number;
        beaconDirection: number[];
        shadowBeaconId: string | null;
        environmentTexture: string | null;
        environmentBakes: number;
        sources: { id: string; kind: string; position: number[]; visible: boolean }[];
      };
    };
    __CITY_PERF__?: {
      backend: string;
      adapter: ReturnType<typeof rendererDeviceInfo>;
      samples: LightingPerfSample[];
      gpuSamples: LightingGpuSample[];
      quality: {
        choice: QualityChoice;
        tier: QualityTier;
        idle: boolean;
        changes: readonly GovernorChange[];
      };
      reset: () => void;
    };
  }
}

/** Sun + lighthouse shadow map renders per second over the recent window. */
function shadowRenders(recent: LightingPerfSample[]): string {
  const span = recent.length > 1 ? (recent.at(-1)!.time - recent[0]!.time) / 1000 : 0;
  if (span <= 0) {
    return "0+0";
  }
  const sun = recent.reduce((sum, s) => sum + s.sunShadowRenders, 0) / span;
  const beacon = recent.reduce((sum, s) => sum + s.beaconShadowRenders, 0) / span;
  return `${sun.toFixed(1)}+${beacon.toFixed(1)}`;
}

/** CPU submission time and GPU timestamps are deliberately reported separately. */
export function PerfHud() {
  const renderer = gpuRenderer(useThree((s) => s.gl));
  const runtime = useLighting();
  const frameStart = useRef(0);
  const previous = useRef(0);
  useFrame(() => {
    renderer.info.reset();
    runtime.frameWork.volumePasses = 0;
    runtime.frameWork.volumeBlurPasses = 0;
    runtime.frameWork.sunShadowRenders = 0;
    runtime.frameWork.beaconShadowRenders = 0;
    if (renderer.lighting instanceof ActiveClusteredLighting) {
      renderer.lighting.work.dispatches = 0;
      renderer.lighting.work.pointLightVisits = 0;
    }
    frameStart.current = performance.now();
  }, -1000);
  useEffect(() => {
    const box = document.createElement("div");
    box.className =
      "pointer-events-none fixed bottom-3 left-3 z-50 rounded-lg bg-black/60 px-2 py-1 font-mono text-[11px] text-white";
    document.body.appendChild(box);
    const samples: LightingPerfSample[] = [];
    const gpuSamples: LightingGpuSample[] = [];
    let generation = 0;
    let gpuId = 0;
    let latestGpu: LightingGpuSample | null = null;
    const metrics = {
      backend: isWebGPU(renderer) ? "webgpu" : "webgl",
      adapter: rendererDeviceInfo(renderer),
      samples,
      gpuSamples,
      get quality() {
        const state = useUiStore.getState();
        return {
          choice: state.quality,
          tier: selectTier(state),
          idle: state.idle,
          changes: qualityHistory,
        };
      },
      reset: () => {
        samples.length = 0;
        gpuSamples.length = 0;
        latestGpu = null;
        generation++;
        previous.current = 0;
      },
    };
    window.__CITY_PERF__ = metrics;
    const autoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    let lastDisplay = 0;
    let resolving = false;
    let disposed = false;
    const unsubscribe = addAfterEffect(() => {
      const now = performance.now();
      const { render, memory } = renderer.info;
      const interval = previous.current ? now - previous.current : 0;
      previous.current = now;
      samples.push({
        time: now,
        intervalMs: interval,
        cpuMs: now - frameStart.current,
        gpuMs: latestGpu?.gpuMs ?? null,
        gpuSampleId: latestGpu?.id ?? null,
        ...runtime.frameWork,
        clusterDispatches:
          renderer.lighting instanceof ActiveClusteredLighting
            ? renderer.lighting.work.dispatches
            : 0,
        clusteredPointLightVisits:
          renderer.lighting instanceof ActiveClusteredLighting
            ? renderer.lighting.work.pointLightVisits
            : 0,
        draws: render.drawCalls,
        triangles: render.triangles,
        textures: memory.textures,
        bytes: memory.total,
      });
      if (samples.length > 3600) {
        samples.shift();
      }
      if (now - lastDisplay < 500) {
        return;
      }
      lastDisplay = now;
      const recent = samples.filter((s) => now - s.time < 2000 && s.intervalMs > 0);
      const frameMs = recent.reduce((sum, s) => sum + s.intervalMs, 0) / Math.max(1, recent.length);
      const quality = metrics.quality;
      box.textContent = `${metrics.backend} · ${quality.choice === "auto" ? `auto/${quality.tier}` : quality.tier}${quality.idle ? " (idle)" : ""} · ${(1000 / Math.max(1, frameMs)).toFixed(0)} fps · ${samples.at(-1)!.cpuMs.toFixed(1)} ms CPU · ${latestGpu == null ? "GPU n/a" : `${latestGpu.gpuMs.toFixed(1)} ms GPU (async)`} · ${render.drawCalls} draws · ${(memory.total / 1048576).toFixed(1)} MiB · shadows ${shadowRenders(recent)}/s`;
      if (
        !resolving &&
        renderParams.get("profile") !== "1" &&
        (renderer.backend as unknown as { trackTimestamp: boolean }).trackTimestamp
      ) {
        resolving = true;
        const requestedAt = now;
        const requestedGeneration = generation;
        Promise.all([
          renderer.resolveTimestampsAsync("render"),
          ...(isWebGPU(renderer) ? [renderer.resolveTimestampsAsync("compute")] : []),
        ])
          .then(() => {
            if (!disposed && requestedGeneration === generation) {
              const renderMs = renderer.info.render.timestamp;
              const computeMs = isWebGPU(renderer) ? renderer.info.compute.timestamp : 0;
              latestGpu = {
                id: ++gpuId,
                requestedAt,
                resolvedAt: performance.now(),
                renderMs,
                computeMs,
                gpuMs: renderMs + computeMs,
              };
              gpuSamples.push(latestGpu);
              if (gpuSamples.length > 120) {
                gpuSamples.shift();
              }
            }
          })
          .catch(() => {
            if (requestedGeneration === generation) {
              latestGpu = null;
            }
          })
          .finally(() => {
            resolving = false;
          });
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      box.remove();
      renderer.info.autoReset = autoReset;
      if (window.__CITY_PERF__ === metrics) {
        delete window.__CITY_PERF__;
      }
    };
  }, [renderer, runtime]);
  return null;
}

export const PERF_HUD =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("perf");
