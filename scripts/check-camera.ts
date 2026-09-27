/** Camera regression: viewport resolution must stay stable during orbit, zoom and damping.
 * Start a production preview, then run with CITY_URL, CITY_BACKEND, CHROMIUM_PATH as needed.
 * CAMERA_BASELINE=1 records without asserting, for before/after comparisons.
 */
import {
  assertHardwareAdapter,
  benchmarkEnvironment,
  benchmarkPage,
  benchmarkParams,
  cityUrl,
  launchCheck,
  lightingSummary,
} from "./harness";
import {
  benchmarkDuration,
  benchmarkFrameBudget,
  benchmarkViewport,
  fixtureWorld,
  lightingCases,
  loadBenchmarkWorld,
  previewLighting,
} from "./lighting-fixture";
import { summarizePerf } from "./perf-summary";

const cityParams = benchmarkParams();
const { backend, software, output, browser, page, errors } = await launchCheck(
  "camera",
  benchmarkPage,
);
await page.addInitScript(() => {
  const probe = {
    sizes: [] as { axis: string; value: number; time: number }[],
    compute: 0,
    render: 0,
    webglShaders: 0,
    webglPrograms: 0,
    pipelines: [] as { method: string; label: string; time: number }[],
  };
  Object.assign(window, { __CAMERA_PROBE__: probe });
  for (const axis of ["width", "height"]) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, axis)!;
    Object.defineProperty(HTMLCanvasElement.prototype, axis, {
      ...descriptor,
      set(value: number) {
        if (this.dataset.cameraProbe && descriptor.get!.call(this) !== value) {
          probe.sizes.push({ axis, value, time: performance.now() });
        }
        descriptor.set!.call(this, value);
      },
    });
  }
  if (typeof GPUDevice !== "undefined") {
    for (const method of [
      "createComputePipeline",
      "createComputePipelineAsync",
      "createRenderPipeline",
      "createRenderPipelineAsync",
    ] as const) {
      const original = GPUDevice.prototype[method];
      Object.defineProperty(GPUDevice.prototype, method, {
        configurable: true,
        writable: true,
        value(...args: unknown[]) {
          probe.pipelines.push({
            method,
            label: (args[0] as { label?: string }).label ?? "",
            time: performance.now(),
          });
          if (method.includes("Compute")) {
            probe.compute++;
          } else {
            probe.render++;
          }
          return Reflect.apply(original, this, args);
        },
      });
    }
  }
  for (const method of ["compileShader", "linkProgram"] as const) {
    const original = WebGL2RenderingContext.prototype[method];
    Object.defineProperty(WebGL2RenderingContext.prototype, method, {
      configurable: true,
      writable: true,
      value(...args: unknown[]) {
        if (method === "compileShader") {
          probe.webglShaders++;
        } else {
          probe.webglPrograms++;
        }
        probe.pipelines.push({ method, label: "webgl2", time: performance.now() });
        return Reflect.apply(original, this, args);
      },
    });
  }
});
const phases: object[] = [];
const environment = {
  ...benchmarkEnvironment(browser, cityParams),
  durationMs: benchmarkDuration,
};

const focusNodes = fixtureWorld.cities.flatMap((city) => city.nodes);
const firstFocus = focusNodes.find((node) => node.type === "app") ?? focusNodes[0];
const secondFocus =
  focusNodes.find((node) => node.type !== firstFocus?.type) ?? focusNodes[1] ?? firstFocus;
const focusLabels = [firstFocus, secondFocus].flatMap((node) => (node ? [node.label] : []));
if (!focusLabels.length) {
  throw new Error("Camera benchmark needs at least one service");
}

async function exercise(duration: number, warmup = false) {
  const x = benchmarkViewport.width * 0.8;
  const y = benchmarkViewport.height * 0.6;
  // Each third exercises a distinct interaction, including the application's focus animation.
  let start = performance.now();
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 0; performance.now() - start < duration / 3; i++) {
    await page.mouse.move(x + Math.sin(i / 8) * 65, y + Math.sin(i / 12) * 25);
    await page.waitForTimeout(70);
  }
  await page.mouse.up();
  start = performance.now();
  for (let i = 0; performance.now() - start < duration / 3; i++) {
    await page.mouse.wheel(0, i % 2 ? 120 : -120);
    await page.waitForTimeout(500);
  }
  start = performance.now();
  for (let i = 0; performance.now() - start < duration / 3 || (warmup && i < 2); i++) {
    const search = page.getByPlaceholder("Find a node...");
    await search.fill(focusLabels[i % focusLabels.length]!);
    await search.press("Enter");
    if (warmup) {
      const time = await page.evaluate(() => window.__CITY_PERF__!.samples.at(-1)!.time);
      await page.waitForFunction(
        (after) =>
          window.__CITY_PERF__!.samples.filter((sample) => sample.time > after).length >= 3,
        time,
      );
    }
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
    await search.fill("");
  }
}

try {
  await page.goto(`${cityUrl}?perf=1&renderer=${backend}${cityParams}`);
  await page.waitForFunction(
    () => window.__CITY_RENDER__ && (window.__CITY_PERF__?.samples.length ?? 0) > 5,
  );
  await page.locator("canvas").evaluate((canvas) => {
    canvas.dataset.cameraProbe = "1";
  });
  await loadBenchmarkWorld(page);
  const actualBackend = await page.evaluate(() => window.__CITY_PERF__!.backend);
  if (actualBackend !== backend) {
    throw new Error(`Requested ${backend}, received ${actualBackend}`);
  }
  environment.adapter = await assertHardwareAdapter(page, software);

  await lightingSummary(page).click();
  // The first car tint / truck activates its native material variant only after spawning.
  await page.waitForFunction(() => {
    const sources = window.__CITY_RENDER__!.inspect().sources;
    return (
      sources.some((s) => s.id.includes(":car:")) && sources.some((s) => s.id.includes(":truck:"))
    );
  });
  const snapshot = () =>
    page.evaluate(() => ({
      probe: structuredClone((window as unknown as { __CAMERA_PROBE__: object }).__CAMERA_PROBE__),
      scene: window.__CITY_RENDER__!.inspect(),
      samples: window.__CITY_PERF__!.samples.slice(),
      gpuSamples: window.__CITY_PERF__!.gpuSamples?.slice() ?? [],
      size: [document.querySelector("canvas")!.width, document.querySelector("canvas")!.height],
      backend: window.__CITY_PERF__!.backend,
    }));
  for (const [label, date] of lightingCases) {
    if (label === "dawn" || (process.env.CITY_CASE && process.env.CITY_CASE !== label)) {
      continue;
    }
    await previewLighting(page, date);
    // Visit the same starting view and both focus targets before measurement.
    // A second traversal covers objects revealed by orbiting and the first selection.
    for (let warmup = 0; warmup < 2; warmup++) {
      await page.evaluate(() => window.__CITY_RENDER__!.focus([35, 30, 45], [0, 0, 0]));
      await page.waitForTimeout(1000);
      await exercise(6000, true);
    }
    await page.evaluate(() => window.__CITY_RENDER__!.focus([35, 30, 45], [0, 0, 0]));
    await page.waitForTimeout(3000);
    const before = await snapshot();
    phases.push({ phase: `${label}-before`, ...before });
    await page.evaluate(() => window.__CITY_PERF__!.reset());
    await exercise(benchmarkDuration);
    await page.waitForFunction(() => (window.__CITY_PERF__?.samples.length ?? 0) >= 2);
    const after = await snapshot();
    const summary = summarizePerf(after.samples, after.gpuSamples, benchmarkFrameBudget);
    const probe = after.probe as {
      sizes: unknown[];
      compute: number;
      render: number;
      webglShaders: number;
      webglPrograms: number;
    };
    const previous = before.probe as typeof probe;
    const resizes = probe.sizes.length - previous.sizes.length;
    const pipelines = {
      compute: probe.compute - previous.compute,
      render: probe.render - previous.render,
      webglShaders: probe.webglShaders - previous.webglShaders,
      webglPrograms: probe.webglPrograms - previous.webglPrograms,
    };
    const moved = Math.hypot(...after.scene.camera.map((v, i) => v - before.scene.camera[i]!));
    phases.push({ phase: `${label}-after`, ...after, summary, resizes, pipelines, moved });
    console.log(JSON.stringify({ label, backend, summary, resizes, pipelines, moved }));
    if (moved < 0.5) {
      throw new Error("Camera did not move");
    }
    if (process.env.CAMERA_BASELINE !== "1") {
      if (resizes > 0 || Object.values(pipelines).some((count) => count > 0)) {
        throw new Error("Warm camera motion resized buffers or compiled new pipelines");
      }
      if (
        (process.env.CITY_ASSERT_BUDGET === "1" || process.env.CITY_ASSERT_60 === "1") &&
        !software &&
        (summary.frameP95Ms ?? Infinity) > benchmarkFrameBudget
      ) {
        throw new Error(`Target hardware missed the ${benchmarkFrameBudget} ms frame p95 budget`);
      }
    }
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
} finally {
  await Bun.write(
    `${output}/report.json`,
    JSON.stringify({ software, backend, environment, errors, phases }, null, 2),
  );
  await Bun.write(`${output}/world.json`, JSON.stringify(fixtureWorld, null, 2));
  await browser.close();
}
