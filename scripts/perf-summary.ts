import type { LightingGpuSample, LightingPerfSample } from "../src/components/PerfTuning";

function percentile(values: number[], fraction: number) {
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
}

/** GPU observations are asynchronous and must not be weighted by repeated frame references. */
export function summarizePerf(
  samples: LightingPerfSample[],
  gpuSamples: LightingGpuSample[] = [],
  frameBudgetMs = 18,
) {
  const intervals = samples.map((sample) => sample.intervalMs).filter((ms) => ms > 0);
  const elapsed = intervals.reduce((sum, ms) => sum + ms, 0);
  return {
    fps: elapsed ? (intervals.length * 1000) / elapsed : null,
    measuredMs: elapsed,
    frameP95Ms: percentile(intervals, 0.95),
    frameBudgetMs,
    framesOverBudgetPct: intervals.length
      ? (intervals.filter((ms) => ms > frameBudgetMs).length / intervals.length) * 100
      : null,
    framesOver18Ms: intervals.filter((ms) => ms > 18).length,
    framesOver18Pct: intervals.length
      ? (intervals.filter((ms) => ms > 18).length / intervals.length) * 100
      : null,
    cpuP95Ms: percentile(
      samples.map((sample) => sample.cpuMs),
      0.95,
    ),
    gpuAsyncP95Ms: percentile(
      gpuSamples.map((sample) => sample.gpuMs),
      0.95,
    ),
    gpuObservations: gpuSamples.length,
    last: samples.at(-1),
  };
}
