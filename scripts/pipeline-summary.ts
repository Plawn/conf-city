import { mean } from "../src/lib/stats";

export interface PipelineBenchmarkRow {
  case: string;
  variant: string;
  run: number;
  gpuMs: number | null;
  gpuP95Ms: number | null;
  groups: { name: string; meanMs: number }[];
  gpuElapsedMs?: number | null;
  gpuElapsedP95Ms?: number | null;
  cpuMs?: number;
  fps?: number | null;
  frameP95Ms?: number;
  trackedBytes?: number;
  controlCpuMs?: number;
  controlFps?: number | null;
  controlFrameP95Ms?: number;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Weight repetitions equally, pair each ablation with its own run's baseline. */
export function summarizePipelineBenchmark(rows: readonly PipelineBenchmarkRow[]) {
  const valid = rows.filter((row) => row.gpuMs !== null && Number.isFinite(row.gpuMs));
  return [...new Set(rows.map((row) => row.case))].map((caseName) => {
    const captures = valid.filter((row) => row.case === caseName);
    const observations = rows.filter((row) => row.case === caseName);
    const metric = (samples: readonly PipelineBenchmarkRow[], key: keyof PipelineBenchmarkRow) => {
      const values = samples.flatMap((row) =>
        typeof row[key] === "number" && Number.isFinite(row[key]) ? [row[key] as number] : [],
      );
      return values.length ? median(values) : null;
    };
    const baseline = captures.filter((row) => row.variant === "baseline");
    const baselines = new Map(baseline.map((row) => [row.run, row.gpuMs!]));
    const groups = [...new Set(baseline.flatMap((row) => row.groups.map((group) => group.name)))];
    return {
      case: caseName,
      observations: [...new Set(observations.map((row) => row.variant))].map((variant) => {
        const samples = observations.filter((row) => row.variant === variant);
        return {
          variant,
          captures: samples.length,
          gpuElapsedMs: metric(samples, "gpuElapsedMs"),
          gpuElapsedP95Ms: metric(samples, "gpuElapsedP95Ms"),
          cpuMs: metric(samples, "cpuMs"),
          fps: metric(samples, "fps"),
          frameP95Ms: metric(samples, "frameP95Ms"),
          trackedBytes: metric(samples, "trackedBytes"),
        };
      }),
      baselineGpuMs: baseline.length ? median(baseline.map((row) => row.gpuMs!)) : null,
      groups: groups
        .map((name) => {
          // An intermittent pass absent from a complete capture contributes zero.
          const values = baseline.map(
            (row) => row.groups.find((group) => group.name === name)?.meanMs ?? 0,
          );
          const total = mean(baseline.map((row) => row.gpuMs!));
          return { name, meanMs: mean(values), share: total > 0 ? mean(values) / total : 0 };
        })
        .sort((a, b) => b.meanMs - a.meanMs),
      variants: [...new Set(rows.map((row) => row.variant))].map((variant) => {
        const samples = captures.filter((row) => row.variant === variant);
        const values = samples.map((row) => row.gpuMs!);
        const paired = samples.filter((row) => baselines.has(row.run));
        const p95 = samples.flatMap((row) => (row.gpuP95Ms === null ? [] : [row.gpuP95Ms]));
        return {
          variant,
          runs: samples.length,
          gpuMs: values.length ? median(values) : null,
          minGpuMs: values.length ? Math.min(...values) : null,
          maxGpuMs: values.length ? Math.max(...values) : null,
          gpuP95Ms: p95.length ? median(p95) : null,
          pairedRuns: paired.length,
          savedMs: paired.length
            ? median(paired.map((row) => baselines.get(row.run)! - row.gpuMs!))
            : null,
          savedPct: paired.length
            ? median(
                paired.map((row) => {
                  const base = baselines.get(row.run)!;
                  return base > 0 ? ((base - row.gpuMs!) / base) * 100 : 0;
                }),
              )
            : null,
        };
      }),
    };
  });
}

export function formatPipelineBenchmark(
  summary: ReturnType<typeof summarizePipelineBenchmark>,
  context = "",
) {
  const ms = (value: number | null) => (value === null ? "unavailable" : value.toFixed(2));
  const lines = [
    "# 3D pipeline benchmark",
    "",
    context,
    "",
    "GPU milliseconds are native pass durations. They are not GPU utilization or power consumption.",
    "Repetitions have equal weight; totals and savings are medians across runs. Savings pair each variant with its run's baseline.",
    "Ablations change the image and may affect other passes: savings are not additive. Ranges are observed run means, not confidence intervals.",
    "Simulation, DOM work and environment baking outside the composed draw are excluded from GPU pass timings.",
  ];
  for (const item of summary) {
    lines.push(
      "",
      `## ${item.case}`,
      "",
      "| GPU pass family (baseline) | Mean ms | Share |",
      "| --- | ---: | ---: |",
      ...item.groups.map(
        (group) => `| ${group.name} | ${ms(group.meanMs)} | ${(group.share * 100).toFixed(1)}% |`,
      ),
      "",
      "| Variant | Runs | GPU ms | Observed range | GPU p95 ms | Paired saving |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...item.variants.map(
        (variant) =>
          `| ${variant.variant} | ${variant.runs} | ${ms(variant.gpuMs)} | ${ms(variant.minGpuMs)}–${ms(variant.maxGpuMs)} | ${ms(variant.gpuP95Ms)} | ${ms(variant.savedMs)} ms / ${variant.savedPct?.toFixed(1) ?? "unavailable"}% (${variant.pairedRuns} pairs) |`,
      ),
      "",
      "WebGL elapsed queries cover the whole composed pipeline; WebGPU above sums exclusive pass durations. These scopes differ. Null queries are excluded, never replaced by CPU times.",
      "",
      "| Variant | Captures | WebGL GPU elapsed ms | CPU update/submission ms | FPS | Frame p95 ms | Renderer tracked MiB |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...item.observations.map(
        (row) =>
          `| ${row.variant} | ${row.captures} | ${ms(row.gpuElapsedMs)} | ${ms(row.cpuMs)} | ${ms(row.fps)} | ${ms(row.frameP95Ms)} | ${ms(row.trackedBytes === null ? null : row.trackedBytes / 1048576)} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
