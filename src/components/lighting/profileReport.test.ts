import { expect, test } from "bun:test";
import {
  type PipelineFrameSample,
  passGroup,
  pipelineSpeedscope,
  summarizePipeline,
} from "./profileReport";

const frame = (scene: number | null, shadow?: number): PipelineFrameSample => ({
  time: 100,
  cpuMs: 3,
  passes: [
    {
      uid: "r:1:f1",
      name: "City scene",
      group: "Scene",
      kind: "render",
      cpuMs: 3,
      gpuMs: scene,
    },
    ...(shadow === undefined
      ? []
      : [
          {
            uid: "r:2:f1",
            name: "Sun shadow",
            group: "Shadows",
            kind: "render" as const,
            cpuMs: 1,
            gpuMs: shadow,
          },
        ]),
  ],
});

test("GPU summaries exclude partial frames and amortize intermittent shadows over all complete frames", () => {
  const summary = summarizePipeline([frame(10, 4), frame(6), frame(null, 100)]);
  expect(summary.completeGpuFrames).toBe(2);
  expect(summary.gpuMeanMs).toBe(10);
  expect(summary.gpuP95Ms).toBe(14);
  expect(summary.groups.find((group) => group.name === "Shadows")?.meanMs).toBe(2);
  expect(summary.groups.reduce((sum, group) => sum + group.share, 0)).toBe(1);
  expect(summarizePipeline([frame(null)]).gpuMeanMs).toBeNull();
});

test("Speedscope weights use exclusive GPU durations exactly once, without CPU scope nesting", () => {
  const report = pipelineSpeedscope([frame(10, 4), frame(6), frame(null, 100), frame(0)]);
  expect(report.profiles[0]!.weights).toEqual([10, 4, 6]);
  expect(report.profiles[0]!.endValue).toBe(20);
  expect(
    report.profiles[0]!.samples.map((stack) => stack.map((i) => report.shared.frames[i]!.name)),
  ).toEqual([
    ["3D GPU work", "Scene", "City scene"],
    ["3D GPU work", "Shadows", "Sun shadow"],
    ["3D GPU work", "Scene", "City scene"],
  ]);
});

test("native pass labels separate scene shading, shadows, clustering and post-processing", () => {
  expect(passGroup("City scene (MRT / materials / lights)")).toBe("Scene / materials / lighting");
  expect(passGroup("Sun shadow")).toBe("Shadows");
  expect(passGroup("Lighthouse shadow")).toBe("Shadows");
  expect(passGroup("VSMVertical")).toBe("Shadows");
  expect(passGroup("VSMHorizontal")).toBe("Shadows");
  expect(passGroup("Update Clustered Lights", true)).toBe("Light clustering");
  expect(passGroup("Bloom [ Blur Horizontal - 0 ]")).toBe("Bloom");
  expect(passGroup("Render Pipeline")).toBe("Composition / antialiasing");
});
