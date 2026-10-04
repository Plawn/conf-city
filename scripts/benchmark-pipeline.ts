import { cpus, release, totalmem } from "node:os";
import { mean, percentile } from "../src/lib/stats";
import {
  formatPipelineBenchmark,
  type PipelineBenchmarkRow,
  summarizePipelineBenchmark,
} from "./pipeline-summary";

// Set defaults before loading the shared browser fixture, which reads them at import time.
process.env.CITY_RENDER_MODE ??= "office";
process.env.CITY_WIDTH ??= "1280";
process.env.CITY_HEIGHT ??= "800";
const {
  assertHardwareAdapter,
  benchmarkEnvironment,
  benchmarkPage,
  benchmarkParams,
  cityUrl,
  launchCheck,
  savePng,
  withLightingPanel,
} = await import("./harness");
const { fixtureWorld, installLightingFixture, lightingCases, loadBenchmarkWorld, previewLighting } =
  await import("./lighting-fixture");

const variants = [
  { name: "baseline", params: "" },
  { name: "no-ao", params: "&ao=0" },
  { name: "ao-reference", params: "&ao=reference" },
  { name: "no-bloom", params: "&bloom=0" },
  { name: "bloom-reference", params: "&bloom=reference" },
  { name: "no-volume", params: "&volume=0" },
  { name: "no-local-lights", params: "&localLights=0" },
  { name: "no-shadows", params: "&shadows=0" },
  { name: "no-water", params: "&water=0" },
  { name: "no-fxaa", params: "&antialias=0" },
];
const requested = process.env.CITY_VARIANTS?.split(",");
if (requested?.some((name) => !variants.some((variant) => variant.name === name))) {
  throw new Error(`CITY_VARIANTS must use: ${variants.map((variant) => variant.name).join(",")}`);
}
const selected = variants.filter(
  (variant) =>
    (!requested && !["bloom-reference", "ao-reference"].includes(variant.name)) ||
    variant.name === "baseline" ||
    requested?.includes(variant.name),
);
const runs = Number(process.env.CITY_RUNS ?? 3);
const duration = Number(process.env.CITY_DURATION_MS ?? 10_000);
const warmup = Number(process.env.CITY_WARMUP_MS ?? 5_000);
const controlDuration = Number(process.env.CITY_CONTROL_MS ?? 0);
if (!Number.isFinite(controlDuration) || controlDuration < 0 || controlDuration > 30_000) {
  throw new Error("CITY_CONTROL_MS must be between 0 and 30000");
}
if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(warmup) || warmup < 0) {
  throw new Error("CITY_RUNS must be a positive integer; CITY_WARMUP_MS must be non-negative");
}
if (!Number.isFinite(duration) || duration < 1000 || duration > 30_000) {
  throw new Error("CITY_DURATION_MS must be between 1000 and 30000");
}
const cases = lightingCases.filter(([name]) =>
  process.env.CITY_CASE ? name === process.env.CITY_CASE : name !== "dawn",
);
if (!cases.length) {
  throw new Error("CITY_CASE must be noon, dawn or night");
}

const {
  backend,
  software,
  output,
  browser,
  page: initialPage,
} = await launchCheck("benchmark-pipeline", benchmarkPage);
await initialPage.close();
const params = `${benchmarkParams()}${/tweaks=/.test(benchmarkParams()) ? "" : "&tweaks="}`;
const rows: PipelineBenchmarkRow[] = [];
const metadata = {
  ...benchmarkEnvironment(browser, params),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  memoryBytes: totalmem(),
  os: release(),
  software,
  duration,
  warmup,
  controlDuration,
  runs,
  variants: selected,
  camera: "fit-all, stationary",
  telemetryFixture: "healthy services; each host: 2.8/8 CPU cores, 6000/16000 MB RAM, 40% disk",
};
try {
  await Bun.write(`${output}/world.json`, JSON.stringify(fixtureWorld, null, 2));
  for (const [caseName, date] of cases) {
    for (let run = 1; run <= runs; run++) {
      // Rotate the order to reduce bias from temperature, clocks and cache warmup.
      const offset = (run - 1) % selected.length;
      const ordered = [...selected.slice(offset), ...selected.slice(0, offset)];
      for (const variant of ordered) {
        const { deviceScaleFactor, ...viewport } = benchmarkPage;
        const page = await browser.newPage({ viewport, deviceScaleFactor });
        page.setDefaultTimeout(120_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error" && !message.text().includes("favicon")) {
            errors.push(message.text());
          }
        });
        await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
        await installLightingFixture(page);
        const options = new URLSearchParams(params);
        new URLSearchParams(variant.params).forEach((value, key) => {
          options.set(key, value);
        });
        options.set("profile", "1");
        options.set("perf", "1");
        options.set("idle", "0");
        options.set("renderer", backend);
        const url = `${cityUrl}?${options}`;
        await page.goto(url);
        await page.waitForFunction(() => window.__CITY_PROFILE__ && window.__CITY_RENDER__);
        await loadBenchmarkWorld(page);
        metadata.adapter = await assertHardwareAdapter(page, software);
        if (
          !software &&
          (metadata.adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter !== false
        ) {
          throw new Error(
            "GPU benchmark requires verified hardware; GPU_SOFTWARE=1 is functional only",
          );
        }
        await withLightingPanel(page, () => previewLighting(page, date));
        await page.keyboard.press("f");
        await page.waitForTimeout(warmup);
        await page.evaluate((ms) => {
          window.__CITY_PERF__!.reset();
          window.__CITY_PROFILE__!.start(ms);
        }, duration);
        await page.waitForFunction(() => {
          const api = window.__CITY_PROFILE__!;
          return !api.recording && !api.resolving && api.report().frames.length > 0;
        });
        const data = await page.evaluate(() => ({
          buildAssets: [
            ...document.querySelectorAll<HTMLScriptElement>('script[type="module"]'),
          ].map((script) => script.src),
          report: window.__CITY_PROFILE__!.report(),
          samples: window.__CITY_PERF__!.samples.slice(),
          scene: window.__CITY_RENDER__!.inspect(),
          speedscope: window.__CITY_PROFILE__!.speedscope(),
        }));
        const name = `${caseName}-${variant.name}-run-${run}`;
        let control: {
          samples: typeof data.samples;
          fps: number | null;
          cpuMs: number;
          frameP95Ms: number;
        } | null = null;
        if (controlDuration > 0) {
          // Same page and settings, but no GPU queries. This reveals timing
          // instrumentation overhead before attributing FPS to a backend.
          await page.evaluate(() => window.__CITY_PERF__!.reset());
          await page.waitForTimeout(controlDuration);
          const samples = await page.evaluate(() => window.__CITY_PERF__!.samples.slice());
          const intervals = samples.map((sample) => sample.intervalMs).filter((ms) => ms > 0);
          control = {
            samples,
            fps: intervals.length ? 1000 / mean(intervals) : null,
            cpuMs: mean(samples.map((sample) => sample.cpuMs)),
            frameP95Ms: percentile(
              intervals.sort((a, b) => a - b),
              0.95,
            ),
          };
        }
        await Bun.write(
          `${output}/${name}.json`,
          JSON.stringify({ url, ...data, control, errors }, null, 2),
        );
        if (errors.length || data.report.error || data.report.changedDuringCapture) {
          throw new Error(`${name}: invalid capture; inspect its JSON report`);
        }
        if (
          caseName === "night" &&
          variant.name === "baseline" &&
          data.report.startedWith.profile.volume &&
          data.report.startedWith.options.volume !== "0" &&
          data.report.startedWith.options.localLights !== "0" &&
          backend === "webgpu" &&
          !data.samples.some((sample) => (sample.volumePasses ?? 0) > 0)
        ) {
          throw new Error(
            `${name}: the enabled lighthouse volume never ran; check telemetry and camera`,
          );
        }
        if (backend === "webgpu" && data.report.summary.completeGpuFrames < 10 && !software) {
          throw new Error(`${name}: fewer than 10 complete GPU samples`);
        }
        const summary = data.report.summary;
        const intervals = data.samples.map((sample) => sample.intervalMs).filter((ms) => ms > 0);
        rows.push({
          case: caseName,
          variant: variant.name,
          run,
          gpuMs: summary.gpuMeanMs,
          gpuP95Ms: summary.gpuP95Ms,
          groups: summary.groups,
          gpuElapsedMs: summary.gpuElapsedMeanMs,
          gpuElapsedP95Ms: summary.gpuElapsedP95Ms,
          cpuMs: mean(data.samples.map((sample) => sample.cpuMs)),
          fps: intervals.length ? 1000 / mean(intervals) : null,
          frameP95Ms: percentile(
            intervals.sort((a, b) => a - b),
            0.95,
          ),
          trackedBytes: mean(data.samples.map((sample) => sample.bytes)),
          controlCpuMs: control?.cpuMs,
          controlFps: control?.fps,
          controlFrameP95Ms: control?.frameP95Ms,
        });
        await Bun.write(`${output}/rows.json`, JSON.stringify({ metadata, rows }, null, 2));
        const aggregate = summarizePipelineBenchmark(rows);
        await Bun.write(`${output}/summary.json`, JSON.stringify(aggregate, null, 2));
        await Bun.write(
          `${output}/summary.md`,
          formatPipelineBenchmark(
            aggregate,
            `Reference: ${metadata.world.cities} cities / ${metadata.world.nodes} nodes, ${metadata.viewport.width}×${metadata.viewport.height} CSS pixels at DPR ${metadata.dpr}, ${metadata.renderMode}, ${params}. Chromium ${metadata.browser}, ${JSON.stringify(metadata.adapter)}. Camera: ${metadata.camera}. ${runs} runs × ${duration / 1000} s, after ${warmup / 1000} s of warmup following world/camera/lighting setup. ${software ? "SOFTWARE ADAPTER: functional validation only." : "Verified hardware adapter."} See rows.json and per-capture JSON for full metadata, actual render resolution, sampling coverage and raw measurements.`,
          ),
        );
        if (run === 1) {
          await Bun.write(`${output}/${name}.speedscope.json`, JSON.stringify(data.speedscope));
          await savePng(
            await page.evaluate(() => window.__CITY_RENDER__!.capture()),
            `${output}/${name}.png`,
          );
        }
        console.log(
          `${name}: GPU ${summary.gpuMeanMs?.toFixed(2) ?? "n/a"} ms (exclusive passes), WebGL elapsed ${summary.gpuElapsedMeanMs?.toFixed(2) ?? "n/a"} ms / ${summary.gpuElapsedFrames} samples, ${summary.completeGpuFrames} complete pass samples, frame p95 ${percentile(
            intervals.sort((a, b) => a - b),
            0.95,
          ).toFixed(1)} ms, CPU ${mean(data.samples.map((sample) => sample.cpuMs)).toFixed(1)} ms`,
        );
        await page.close();
      }
    }
  }
  console.log(`Reports: ${output}/summary.md`);
} finally {
  await browser.close();
}
