import { expect, test } from "bun:test";
import {
  InspectorBase,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  type WebGPURenderer,
} from "three/webgpu";
import { PipelineProfiler } from "./PipelineProfiler";

function fixture(supported = true) {
  let release!: () => void;
  const readback = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pools = {
    render: { timestamps: new Map<string, number>() },
    compute: { timestamps: new Map<string, number>() },
  };
  const backend = { isWebGPUBackend: true, trackTimestamp: true, timestampQueryPool: pools };
  const original = new InspectorBase();
  const renderer = {
    inspector: original,
    backend,
    hasFeature: () => supported,
    resolveTimestampsAsync: async (kind: "render" | "compute") => {
      await readback;
      if (kind === "render") {
        pools.render.timestamps.set("scene", 10);
        pools.render.timestamps.set("shadow", 2);
      }
    },
  } as unknown as WebGPURenderer;
  const profiler = new PipelineProfiler(renderer);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const target = new RenderTarget();
  target.texture.userData.profileLabel = "City scene";
  const draw = () => {
    profiler.beginRender("scene", scene, camera, target);
    camera.name = "Sun shadow";
    const shadow = new RenderTarget();
    shadow.texture.name = "ShadowMap";
    profiler.beginRender("shadow", scene, camera, shadow);
    profiler.finishRender();
    profiler.finishRender();
    shadow.dispose();
  };
  return { profiler, renderer, backend, pools, release, draw, original };
}

test("pass readback is asynchronous, skips queries on intervening frames and retains exclusive GPU durations", async () => {
  const f = fixture();
  f.profiler.measure(f.draw);
  expect(f.profiler.frames).toHaveLength(0);
  f.profiler.start();
  f.profiler.measure(f.draw);
  expect(f.profiler.resolving).toBe(true);
  expect(f.backend.trackTimestamp).toBe(false);
  expect(f.profiler.frames[0]!.passes.map((pass) => pass.gpuMs)).toEqual([null, null]);
  let rendered = false;
  f.profiler.measure(() => {
    rendered = true;
    f.draw();
  });
  expect(rendered).toBe(true);
  expect(f.profiler.skippedFrames).toBe(1);
  expect(f.profiler.frames).toHaveLength(1);
  f.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.profiler.frames[0]!.passes.map((pass) => pass.gpuMs)).toEqual([10, 2]);
  expect(f.profiler.frames[0]!.passes.map((pass) => pass.group)).toEqual([
    "Scene / materials / lighting",
    "Shadows",
  ]);
  expect(f.pools.render.timestamps.size).toBe(0);
  f.profiler.start();
  expect(f.profiler.frames).toHaveLength(0);
  f.profiler.dispose();
  expect(f.renderer.inspector).toBe(f.original);
  expect(f.backend.trackTimestamp).toBe(true);
});

test("unsupported devices leave GPU measurements missing and never enable timestamp writes", () => {
  const f = fixture(false);
  f.profiler.start();
  f.profiler.measure(() => {
    expect(f.backend.trackTimestamp).toBe(false);
    f.draw();
  });
  expect(f.profiler.resolving).toBe(false);
  expect(f.profiler.frames[0]!.passes.every((pass) => pass.gpuMs === null)).toBe(true);
  f.profiler.dispose();
});

test("disposal discards late GPU data and restores the preceding inspector", async () => {
  const f = fixture();
  f.profiler.start();
  f.profiler.measure(f.draw);
  f.profiler.dispose();
  f.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.profiler.frames[0]!.passes.every((pass) => pass.gpuMs === null)).toBe(true);
  expect(f.renderer.inspector).toBe(f.original);
});
