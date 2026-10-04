import { expect, test } from "bun:test";
import {
  formatPipelineBenchmark,
  type PipelineBenchmarkRow,
  summarizePipelineBenchmark,
} from "../../scripts/pipeline-summary";

function row(
  variant: string,
  run: number,
  gpuMs: number | null,
  groups: PipelineBenchmarkRow["groups"] = [],
): PipelineBenchmarkRow {
  return { case: "noon", variant, run, gpuMs, gpuP95Ms: gpuMs, groups };
}

test("ablation savings pair within each repetition and keep regressions negative", () => {
  const [result] = summarizePipelineBenchmark([
    row("baseline", 1, 10),
    row("baseline", 2, 20),
    row("no-ao", 1, 8),
    row("no-ao", 2, 14),
    row("no-ao", 3, 1), // No baseline for this repetition: excluded from savings.
    row("no-bloom", 1, 12),
  ]);
  expect(result!.variants.find((variant) => variant.variant === "no-ao")).toMatchObject({
    runs: 3,
    pairedRuns: 2,
    savedMs: 4,
    savedPct: 25,
  });
  expect(result!.variants.find((variant) => variant.variant === "no-bloom")?.savedMs).toBe(-2);
});

test("missing GPU observations stay unavailable; intermittent passes count as zero", () => {
  const summary = summarizePipelineBenchmark([
    row("baseline", 1, 10, [{ name: "Shadows", meanMs: 2 }]),
    row("baseline", 2, 10),
    row("baseline", 3, null),
    row("no-ao", 1, null),
  ]);
  expect(summary[0]!.groups).toEqual([{ name: "Shadows", meanMs: 1, share: 0.1 }]);
  expect(summary[0]!.variants.find((variant) => variant.variant === "baseline")?.runs).toBe(2);
  expect(summary[0]!.variants.find((variant) => variant.variant === "no-ao")).toMatchObject({
    runs: 0,
    gpuMs: null,
    savedMs: null,
  });
  expect(formatPipelineBenchmark(summary)).toContain("unavailable");
});

test("day and night use their own baselines and never pool their costs", () => {
  const summary = summarizePipelineBenchmark([
    row("baseline", 1, 10),
    { ...row("baseline", 1, 30), case: "night" },
    { ...row("no-ao", 1, 25), case: "night" },
  ]);
  expect(summary[0]!.baselineGpuMs).toBe(10);
  expect(summary[1]!.baselineGpuMs).toBe(30);
  expect(summary[1]!.variants.find((variant) => variant.variant === "no-ao")?.savedMs).toBe(5);
});
