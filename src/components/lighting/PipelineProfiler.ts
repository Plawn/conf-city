import { InspectorBase, type WebGPURenderer } from "three/webgpu";
import { type PipelineFrameSample, type PipelinePassSample, passGroup } from "./profileReport";

/** r185 backend timestamp API, absent from the current DefinitelyTyped declarations. */
interface TimingBackend {
  trackTimestamp: boolean;
  timestampQueryPool: Record<string, { timestamps: Map<string, number> } | null>;
}

const profilers = new WeakMap<WebGPURenderer, PipelineProfiler>();

export function renderProfiledPipeline(renderer: WebGPURenderer, render: () => void) {
  const profiler = profilers.get(renderer);
  if (profiler) {
    profiler.measure(render);
  } else {
    render();
  }
}

/** Passive renderer hooks: no extra draws, waits, shader changes or fabricated GPU clock. */
export class PipelineProfiler extends InspectorBase {
  readonly frames: PipelineFrameSample[] = [];
  readonly supported: boolean;
  recording = false;
  resolving = false;
  skippedFrames = 0;
  error: string | null = null;
  private deadline = 0;
  private active: PipelineFrameSample | null = null;
  private stack: { sample: PipelinePassSample; start: number }[] = [];
  private disposed = false;
  private generation = 0;
  private readonly backend: TimingBackend;
  private readonly previousInspector: InspectorBase;
  private readonly previousTracking: boolean;

  constructor(private readonly renderer: WebGPURenderer) {
    super();
    this.backend = renderer.backend as unknown as TimingBackend;
    this.previousInspector = renderer.inspector;
    this.previousTracking = this.backend.trackTimestamp;
    // WebGL's disjoint queries have different semantics: leave GPU costs unavailable there.
    this.supported =
      "isWebGPUBackend" in renderer.backend && renderer.hasFeature("timestamp-query");
    this.backend.trackTimestamp = false;
    renderer.inspector = this;
    profilers.set(renderer, this);
  }

  start(durationMs = 10_000) {
    if (this.resolving) {
      return;
    }
    this.generation++;
    this.frames.length = 0;
    this.skippedFrames = 0;
    this.error = null;
    this.deadline = performance.now() + Math.min(30_000, Math.max(1000, durationMs));
    this.recording = true;
  }

  stop() {
    this.recording = false;
  }

  measure(render: () => void) {
    if (performance.now() >= this.deadline || this.frames.length >= 1800) {
      this.stop();
    }
    if (!this.recording || this.resolving) {
      if (this.recording) {
        this.skippedFrames++;
      }
      render();
      return;
    }
    const frame: PipelineFrameSample = { time: performance.now(), cpuMs: 0, passes: [] };
    this.active = frame;
    this.backend.trackTimestamp = this.supported;
    try {
      render();
    } finally {
      frame.cpuMs = performance.now() - frame.time;
      this.active = null;
      this.stack.length = 0;
      this.frames.push(frame);
      // Launch readback while tracking is enabled. It never blocks subsequent renders;
      // those frames run without queries until this sample has resolved.
      if (this.supported) {
        void this.resolve(frame);
      }
      this.backend.trackTimestamp = false;
    }
  }

  override beginRender(...[uid, scene, camera, target]: Parameters<InspectorBase["beginRender"]>) {
    const textureName = target?.texture.userData.profileLabel ?? target?.texture.name ?? "";
    const name = /shadow/i.test(textureName)
      ? camera.name || "Shadow map"
      : textureName.startsWith("City ")
        ? textureName
        : scene.name || textureName || "Scene";
    this.beginPass(uid, name, "render");
  }

  override finishRender() {
    this.finishPass();
  }

  override beginCompute(...[uid, node]: Parameters<InspectorBase["beginCompute"]>) {
    this.beginPass(uid, node.name || "Compute", "compute");
  }

  override finishCompute() {
    this.finishPass();
  }

  private beginPass(uid: string, name: string, kind: "render" | "compute") {
    if (!this.active) {
      return;
    }
    const sample: PipelinePassSample = {
      uid,
      name,
      group: passGroup(name, kind === "compute"),
      kind,
      cpuMs: 0,
      gpuMs: null,
    };
    this.active.passes.push(sample);
    this.stack.push({ sample, start: performance.now() });
  }

  private finishPass() {
    const entry = this.stack.pop();
    if (entry) {
      entry.sample.cpuMs = performance.now() - entry.start;
    }
  }

  private async resolve(frame: PipelineFrameSample) {
    this.resolving = true;
    const generation = this.generation;
    try {
      await Promise.all([
        this.renderer.resolveTimestampsAsync("render"),
        this.renderer.resolveTimestampsAsync("compute"),
      ]);
      if (!this.disposed && generation === this.generation) {
        for (const pass of frame.passes) {
          const ms = this.backend.timestampQueryPool[pass.kind]?.timestamps.get(pass.uid);
          pass.gpuMs = ms !== undefined && Number.isFinite(ms) && ms >= 0 ? ms : null;
        }
      }
    } catch (error) {
      if (!this.disposed) {
        this.error = String(error);
        this.stop();
      }
    } finally {
      // We are the sole timestamp consumer in profile mode. Bound native retained data too.
      for (const pool of Object.values(this.backend.timestampQueryPool)) {
        pool?.timestamps.clear();
      }
      this.resolving = false;
    }
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.generation++;
    if (profilers.get(this.renderer) === this) {
      profilers.delete(this.renderer);
      this.renderer.inspector = this.previousInspector;
      this.backend.trackTimestamp = this.previousTracking;
    }
  }
}
