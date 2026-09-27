import { expect, test } from "bun:test";
import type { LightingGpuSample, LightingPerfSample } from "@/components/PerfTuning";
import { summarizePerf } from "../../scripts/perf-summary";

test("GPU percentiles count resolved observations once, independently of displayed frame samples", () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({
    intervalMs: i === 0 ? 0 : 16.67,
    cpuMs: 4,
    gpuMs: i < 99 ? 40 : 2,
  })) as LightingPerfSample[];
  const gpu = Array.from({ length: 20 }, (_, id) => ({
    id,
    gpuMs: id === 0 ? 40 : 2,
  })) as LightingGpuSample[];
  const summary = summarizePerf(frames, gpu);
  expect(summary.gpuAsyncP95Ms).toBe(2);
  expect(summary.gpuObservations).toBe(20);
  expect(summary.frameP95Ms).toBe(16.67);
  expect(summary.framesOver18Pct).toBe(0);
  expect(summary.fps).toBeCloseTo(60, 0);
  expect(summarizePerf(frames).gpuAsyncP95Ms).toBeNull();
  expect(summarizePerf([]).fps).toBeNull();
});

test("office benchmarks use the 35 ms budget without treating every 30 fps frame as late", () => {
  const frames = [33.3, 33.4, 50].map((intervalMs) => ({
    intervalMs,
    cpuMs: 3,
  })) as LightingPerfSample[];
  const summary = summarizePerf(frames, [], 35);
  expect(summary.frameBudgetMs).toBe(35);
  expect(summary.framesOverBudgetPct).toBeCloseTo(100 / 3);
});
