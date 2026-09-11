import type { WebGPURenderer } from "three/webgpu";
import { formatTweaks } from "../../domain/qualityOverrides";
import { selectProfile, selectTier, useUiStore } from "../../store/uiStore";
import { PipelineProfiler } from "./PipelineProfiler";
import { pipelineSpeedscope, summarizePipeline } from "./profileReport";
import { isWebGPU, rendererDeviceInfo, renderParams } from "./renderer";

declare global {
  interface Window {
    __CITY_PROFILE__?: ReturnType<typeof createApi>;
  }
}

function createApi(profiler: PipelineProfiler, renderer: WebGPURenderer) {
  const metadata = () => {
    const state = useUiStore.getState();
    return {
      backend: isWebGPU(renderer) ? "webgpu" : "webgl",
      adapter: rendererDeviceInfo(renderer),
      gpuTimestamps: profiler.supported,
      tier: selectTier(state),
      qualityChoice: state.quality,
      // The tier alone no longer describes the budgets: record the tweaks too.
      tweaks: formatTweaks(state.renderOverrides),
      overrides: state.renderOverrides,
      profile: selectProfile(state),
      renderMode: state.renderMode,
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      options: Object.fromEntries(
        [
          "ao",
          "volume",
          "ssgi",
          "lights",
          "localLights",
          "shadows",
          "bloom",
          "renderer",
          "idle",
        ].map((key) => [key, renderParams.get(key)]),
      ),
    };
  };
  let startedWith = metadata();
  let startedAt: string | null = null;
  return {
    start(durationMs = 10_000) {
      if (!profiler.resolving) {
        startedWith = metadata();
        startedAt = new Date().toISOString();
        profiler.start(durationMs);
      }
    },
    stop: () => profiler.stop(),
    get recording() {
      return profiler.recording;
    },
    get resolving() {
      return profiler.resolving;
    },
    report: () => {
      const endedWith = metadata();
      return {
        version: 1,
        startedAt,
        startedWith,
        endedWith,
        // A budget changed mid-capture: the samples mix two pipelines.
        changedDuringCapture:
          JSON.stringify(startedWith.profile) !== JSON.stringify(endedWith.profile),
        skippedWhileReadingGpu: profiler.skippedFrames,
        error: profiler.error,
        summary: summarizePipeline(profiler.frames),
        frames: profiler.frames,
        notes: [
          "Only work inside the 3D render pipeline is captured; simulation and DOM are excluded.",
          "GPU values are native per-pass durations, not wall-clock timestamps or GPU utilization.",
          "Frames rendered during asynchronous readback are not sampled. No GPU wait is inserted.",
          "CPU pass scopes include nested submissions: do not add them together.",
          "Scene GPU cost includes geometry, water, materials and local light shading together.",
          "Missing GPU timestamps remain null; summaries and flamegraphs use complete frames only.",
          "Tweaks are recorded in `startedWith.tweaks`; `changedDuringCapture` flags a mid-capture change.",
        ],
      };
    },
    speedscope: () => pipelineSpeedscope(profiler.frames),
  };
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Debug-only DOM lives outside the 3D scene and does not alter the canvas resolution. */
export function attachPipelineProfilePanel(renderer: WebGPURenderer) {
  const profiler = new PipelineProfiler(renderer);
  const api = createApi(profiler, renderer);
  window.__CITY_PROFILE__ = api;
  const panel = document.createElement("section");
  panel.dataset.pipelineProfiler = "true";
  panel.setAttribute("aria-label", "3D GPU profiler");
  panel.style.cssText =
    "position:fixed;right:12px;top:64px;z-index:1000;width:min(440px,calc(100vw - 24px));max-height:75vh;overflow:auto;background:#111e;color:#eee;border:1px solid #555;border-radius:8px;padding:14px;font:12px/1.5 monospace;box-shadow:0 4px 20px #0006";
  const title = document.createElement("strong");
  title.textContent = "3D pipeline · GPU pass costs";
  const instructions = document.createElement("p");
  instructions.textContent =
    "Let the scene warm up, then record 10 s. Keep quality, tweaks, resolution and time of day fixed: the active tweaks are stored in the report, and changing one mid-capture mixes two pipelines.";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin:10px 0";
  const button = (label: string, action: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.className = "glass-button rounded px-2 py-1 disabled:opacity-40";
    node.addEventListener("click", action);
    controls.append(node);
    return node;
  };
  const record = button("Record 10 s", () => {
    api.start();
    update();
  });
  const stop = button("Stop", () => {
    api.stop();
    update();
  });
  const report = button("Export JSON", () => download("city-pipeline.json", api.report()));
  const flame = button("Export flamegraph", () =>
    download("city-pipeline.speedscope.json", api.speedscope()),
  );
  const rows = document.createElement("div");
  const help = document.createElement("p");
  help.append("Open the flamegraph in ");
  const link = document.createElement("a");
  link.href = "https://www.speedscope.app/";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "speedscope.app";
  link.style.textDecoration = "underline";
  help.append(link, " → Left Heavy. Width = GPU work; this is not a chronological timeline.");
  panel.append(title, instructions, controls, status, rows, help);
  document.body.append(panel);
  const update = () => {
    const summary = summarizePipeline(profiler.frames);
    record.disabled = profiler.recording || profiler.resolving;
    stop.disabled = !profiler.recording;
    report.disabled = profiler.recording || profiler.resolving || !summary.capturedFrames;
    flame.disabled = report.disabled || !summary.gpuMeanMs;
    const phase = profiler.recording ? "Recording" : profiler.resolving ? "Reading GPU" : "Ready";
    const tweaks = formatTweaks(useUiStore.getState().renderOverrides);
    status.textContent = profiler.error
      ? `Capture error: ${profiler.error}`
      : !profiler.supported
        ? "GPU pass timestamps unavailable on this backend/device. JSON contains CPU submission scopes only."
        : `${phase} · ${summary.completeGpuFrames}/${summary.capturedFrames} complete GPU samples` +
          (summary.gpuMeanMs === null
            ? ""
            : ` · mean ${summary.gpuMeanMs.toFixed(2)} ms · p95 ${summary.gpuP95Ms!.toFixed(2)} ms`) +
          (tweaks ? ` · tweaks: ${tweaks}` : "");
    rows.replaceChildren();
    for (const group of summary.groups) {
      const row = document.createElement("div");
      row.style.marginBottom = "8px";
      const label = document.createElement("div");
      label.textContent = `${group.name}: ${group.meanMs.toFixed(2)} ms (${(group.share * 100).toFixed(0)}%)`;
      const bar = document.createElement("progress");
      bar.max = 1;
      bar.value = group.share;
      bar.style.cssText = "width:100%;height:8px;accent-color:#4cc9b0";
      bar.setAttribute("aria-label", group.name);
      row.append(label, bar);
      rows.append(row);
    }
  };
  update();
  const timer = window.setInterval(update, 500);
  return () => {
    window.clearInterval(timer);
    profiler.dispose();
    panel.remove();
    if (window.__CITY_PROFILE__ === api) {
      delete window.__CITY_PROFILE__;
    }
  };
}
