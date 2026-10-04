import type { PipelineBenchmarkRow } from "./pipeline-summary";

// Alternate backends sequentially; never launch competing GPU benchmarks.
process.env.CITY_RENDER_MODE ??= "smooth";
process.env.CITY_WIDTH ??= "1280";
process.env.CITY_HEIGHT ??= "800";
const { outputDir } = await import("./harness");
const { fixtureWorld } = await import("./lighting-fixture");
const output = await outputDir("out/benchmark-backends");
const runs = Number(process.env.CITY_RUNS ?? 3);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("CITY_RUNS must be a positive integer");
}
const scenarios = [
  { name: "native-high", params: "&quality=high" },
  {
    name: "common-effects",
    params: "&quality=high&bloom=reference&localLights=0&tweaks=ao:8,volume:0,beaconShadow:0",
  },
];
await Bun.write(`${output}/world.json`, JSON.stringify(fixtureWorld, null, 2));
const rows: (PipelineBenchmarkRow & { scenario: string; backend: string })[] = [];
const builds = new Set<string>();
const metadata = {
  runs,
  renderMode: process.env.CITY_RENDER_MODE,
  durationMs: Number(process.env.CITY_DURATION_MS ?? 5000),
  warmupMs: Number(process.env.CITY_WARMUP_MS ?? 3000),
  controlMs: Number(process.env.CITY_CONTROL_MS ?? 3000),
  scenarios,
  notes: [
    "Native High has backend differences: WebGL caps AO at 8 samples, limits local lighting and uses a fallback beam without volumetric raymarch or beacon shadows.",
    "Common effects: AO 8, native RGBA16F bloom, local lights off, volumetric raymarch off, beacon shadow off; water, AO denoise, sun shadows, tone mapping and FXAA retained.",
    "WebGPU sums exclusive pass timestamps; WebGL measures elapsed time around the whole pipeline. These are different scopes: do not compute a GPU speedup percentage between them.",
    "FPS is capped by the chosen render mode; CPU includes scene updates and submission, GPU scopes exclude simulation and DOM. Renderer tracked bytes are not OS VRAM measurements.",
  ],
};
const median = (values: number[]) => {
  const sorted = values.sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
};
const format = (values: (number | null | undefined)[], digits = 2) => {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  return valid.length ? median(valid).toFixed(digits) : "unavailable";
};
for (const scenario of scenarios) {
  for (let run = 1; run <= runs; run++) {
    const backends = run % 2 ? ["webgpu", "webgl"] : ["webgl", "webgpu"];
    for (const backend of backends) {
      const directory = `${output}/${scenario.name}-${backend}-run-${run}`;
      const child = Bun.spawn([process.execPath, "scripts/benchmark-pipeline.ts"], {
        env: {
          ...process.env,
          CITY_BACKEND: backend,
          CITY_WORLD: `${output}/world.json`,
          CITY_WORLD_SCALE: "1",
          CITY_RUNS: "1",
          CITY_VARIANTS: "baseline",
          CITY_PARAMS: scenario.params,
          CITY_DURATION_MS: String(metadata.durationMs),
          CITY_WARMUP_MS: String(metadata.warmupMs),
          CITY_CONTROL_MS: String(metadata.controlMs),
          CITY_OUTPUT: directory,
        },
        stdout: "inherit",
        stderr: "inherit",
      });
      if (await child.exited) {
        throw new Error(`${scenario.name}/${backend}/${run}: capture failed`);
      }
      const data = await Bun.file(`${directory}/rows.json`).json();
      for (const row of data.rows as PipelineBenchmarkRow[]) {
        const capture = await Bun.file(`${directory}/${row.case}-baseline-run-1.json`).json();
        for (const asset of capture.buildAssets) {
          builds.add(asset);
        }
        if (builds.size > 1) {
          throw new Error("The production build changed during the backend comparison");
        }
        if (
          backend === "webgl" &&
          capture.report.startedWith.gpuElapsedQuery &&
          capture.report.summary.gpuElapsedFrames < 10
        ) {
          throw new Error("WebGL elapsed timer was supported but produced too few valid queries");
        }
        rows.push({ ...row, scenario: scenario.name, backend, run });
      }
      await Bun.write(
        `${output}/comparison.json`,
        JSON.stringify({ metadata, buildAssets: [...builds], rows }, null, 2),
      );
      const lines = [
        "# WebGPU / WebGL backend comparison",
        "",
        ...metadata.notes.map((note) => `- ${note}`),
        "",
        `Sequential alternating backends, ${runs} repetitions × ${metadata.durationMs / 1000} s, ${metadata.warmupMs / 1000} s warmup, ${metadata.renderMode}. Median run means; see raw captures for adapter, viewport, scene and effective settings.`,
        "",
        "| Scenario | Time | Backend | Runs | GPU exclusive passes ms | WebGL GPU elapsed ms | Profiled CPU ms | Profiled FPS | CPU without queries ms | FPS without queries | Frame p95 without queries ms | Renderer tracked MiB |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ];
      for (const scenario of scenarios) {
        for (const name of [...new Set(rows.map((row) => row.case))]) {
          for (const backend of ["webgpu", "webgl"]) {
            const samples = rows.filter(
              (row) =>
                row.scenario === scenario.name && row.case === name && row.backend === backend,
            );
            if (samples.length) {
              const values = [
                scenario.name,
                name,
                backend,
                samples.length,
                format(samples.map((row) => row.gpuMs)),
                format(samples.map((row) => row.gpuElapsedMs)),
                format(samples.map((row) => row.cpuMs)),
                format(
                  samples.map((row) => row.fps),
                  1,
                ),
                format(samples.map((row) => row.controlCpuMs)),
                format(
                  samples.map((row) => row.controlFps),
                  1,
                ),
                format(samples.map((row) => row.controlFrameP95Ms)),
                format(
                  samples.map((row) =>
                    row.trackedBytes == null ? null : row.trackedBytes / 1048576,
                  ),
                ),
              ];
              lines.push(`| ${values.join(" | ")} |`);
            }
          }
        }
      }
      lines.push(
        "",
        `Completed ${rows.length} captures. No-query controls last ${metadata.controlMs / 1000} s on the same page immediately after each capture.`,
        "",
      );
      await Bun.write(`${output}/comparison.md`, lines.join("\n"));
    }
  }
}
console.log(`Backend comparison: ${output}/comparison.md`);
