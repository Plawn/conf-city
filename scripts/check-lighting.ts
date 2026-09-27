/** Run against `bun run build && bun run preview --port 4174`.
 * GPU_SOFTWARE=1 selects SwiftShader for CI; its timings are not hardware benchmarks.
 */
import { isQualityTier } from "../src/domain/quality";
import { effectiveProfile, parseTweaks } from "../src/domain/qualityOverrides";
import {
  assertHardwareAdapter,
  benchmarkEnvironment,
  benchmarkPage,
  benchmarkParams,
  cityUrl,
  launchCheck,
  lightingSummary,
  savePng,
} from "./harness";
import {
  benchmarkDuration,
  benchmarkFrameBudget,
  fixtureWorld,
  lightingCases,
  loadBenchmarkWorld,
  previewLighting,
} from "./lighting-fixture";
import { summarizePerf } from "./perf-summary";

const cityParams = benchmarkParams();
const forcedTier = new URLSearchParams(cityParams).get("quality");
/** Only a fixed tier is predictable here; "auto" lets the governor pick, so no volume assertion. */
const volumeAllowed = isQualityTier(forcedTier)
  ? effectiveProfile(forcedTier, parseTweaks(new URLSearchParams(cityParams).get("tweaks"))).volume
  : forcedTier !== "auto";
const volumeEnabled = volumeAllowed && !process.env.CITY_PARAMS?.includes("volume=0");

const sampleCount = process.env.CITY_FRAMES ? Number(process.env.CITY_FRAMES) : null;
const { backend, software, output, browser, page, errors } = await launchCheck(
  "lighting",
  benchmarkPage,
);
if (process.env.CITY_REDUCED_MOTION === "1") {
  await page.emulateMedia({ reducedMotion: "reduce" });
}
if (process.env.CITY_NO_GPU === "1") {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined }),
  );
}
const results: object[] = [];
const environment = benchmarkEnvironment(browser, cityParams);
try {
  await page.goto(
    `${cityUrl}?perf=1&renderer=${process.env.CITY_NO_GPU === "1" ? "auto" : backend}${cityParams}`,
  );
  await page.waitForFunction(
    () => window.__CITY_RENDER__ && (window.__CITY_PERF__?.samples.length ?? 0) > 5,
  );
  await loadBenchmarkWorld(page);
  const actualBackend = await page.evaluate(() => window.__CITY_PERF__!.backend);
  environment.adapter = await assertHardwareAdapter(page, software);

  if (actualBackend !== backend) {
    throw new Error(`Requested ${backend}, received ${actualBackend}`);
  }
  await lightingSummary(page).click();
  // Frame the first lighthouse and its neighbouring streets reproducibly.
  await page.evaluate(() => {
    const api = window.__CITY_RENDER__!;
    const source = api.inspect().sources.find((s) => s.kind === "beacon");
    if (source) {
      const [x, , z] = source.position;
      api.focus([x! + 17, 18, z! + 22], [x!, 0, z!]);
    }
  });
  if (process.env.CITY_BEACON_CLOSEUP === "1") {
    await page.evaluate(() => {
      const api = window.__CITY_RENDER__!;
      const state = api.inspect();
      const source = state.sources.find((s) => s.id === state.shadowBeaconId);
      if (source) {
        const [x, y, z] = source.position as [number, number, number];
        const [dx, , dz] = state.beaconDirection as [number, number, number];
        const center = [x + dx * 6, y, z + dz * 6] as [number, number, number];
        api.focus([center[0] + dz * 15, y + 5, center[2] - dx * 15], center);
      }
    });
  }
  for (const [label, date] of lightingCases) {
    if (process.env.CITY_CASE && process.env.CITY_CASE !== label) {
      continue;
    }
    await page.getByLabel("Preview local date & time").fill(date!);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.__CITY_PERF__!.reset());
    if (sampleCount != null) {
      await page.waitForFunction(
        (count) => (window.__CITY_PERF__?.samples.length ?? 0) >= count,
        sampleCount,
      );
    } else {
      await page.waitForTimeout(benchmarkDuration);
      await page.waitForFunction(() => (window.__CITY_PERF__?.samples.length ?? 0) >= 2);
    }
    const state = await page.evaluate(() => ({
      scene: window.__CITY_RENDER__!.inspect(),
      samples: window.__CITY_PERF__!.samples.slice(),
      gpuSamples: window.__CITY_PERF__!.gpuSamples?.slice() ?? [],
    }));
    if (
      label === "night" &&
      (state.scene.night < 0.99 || state.scene.beacon <= 0 || state.scene.activeLights < 4)
    ) {
      throw new Error("Night lights did not activate");
    }
    const last = state.samples.at(-1);
    if (last?.volumePasses != null) {
      const volumeExpected =
        backend === "webgpu" &&
        volumeEnabled &&
        state.scene.night > 0.01 &&
        state.scene.beacon > 0.001;
      if (
        last.volumePasses > 0 !== volumeExpected ||
        last.volumeBlurPasses > 0 !== volumeExpected
      ) {
        throw new Error(`Unexpected volume work in ${label}: ${JSON.stringify(last)}`);
      }
      if (
        label === "noon" &&
        (last.clusteredPointLightVisits !== 0 || last.clusteredSpotLightVisits !== 0)
      ) {
        throw new Error("Zero-intensity daytime lights still enter cluster calculations");
      }
    }
    const summary = summarizePerf(state.samples, state.gpuSamples, benchmarkFrameBudget);
    results.push({
      label,
      ...state,
      summary,
    });

    if (
      process.env.CITY_ASSERT_BUDGET === "1" &&
      (summary.frameP95Ms ?? Infinity) > benchmarkFrameBudget
    ) {
      throw new Error(
        `Target hardware missed the ${benchmarkFrameBudget} ms frame p95 budget in ${label}`,
      );
    }
    const data = await page.evaluate(() => window.__CITY_RENDER__!.capture());
    if (
      process.env.CITY_BEACON_CLOSEUP === "1" &&
      process.env.CITY_REDUCED_MOTION === "1" &&
      label === "night" &&
      backend === "webgpu" &&
      volumeEnabled
    ) {
      // The closeup aims at the middle of the beam over empty sea. A missing
      // projector in the volume pass used to produce an entirely dark image here.
      const brightness = await page.evaluate(async (url) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(bitmap.width / 2 - 2, bitmap.height / 2 - 2, 5, 5).data;
        bitmap.close();
        let total = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          total += Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
        }
        return total / 25;
      }, data);
      if (brightness < 18) {
        throw new Error(`Volumetric beam is not visible at its center (${brightness})`);
      }
      console.log(`Volumetric beam visibility: ${brightness.toFixed(1)}/255`);
    }
    await savePng(data, `${output}/${label}.png`);
    console.log(
      `${backend} ${label}: ${state.scene.activeLights} lights, ${state.samples.length} frames`,
    );
  }
  if (process.env.CITY_TRANSITIONS === "1") {
    for (const [label, date] of [lightingCases[0], lightingCases[2]]) {
      await previewLighting(page, date);
      await page.waitForFunction(
        (night) => {
          const perf = window.__CITY_PERF__!.samples.at(-1);
          if (perf?.volumePasses == null) {
            return false;
          }
          return night
            ? perf.volumePasses > 0 && perf.volumeBlurPasses > 0
            : perf.volumePasses === 0 &&
                perf.volumeBlurPasses === 0 &&
                perf.clusteredPointLightVisits === 0 &&
                perf.clusteredSpotLightVisits === 0;
        },
        label === "night" && backend === "webgpu" && volumeEnabled,
      );
      await savePng(
        await page.evaluate(() => window.__CITY_RENDER__!.capture()),
        `${output}/transition-${label}.png`,
      );
      results.push({
        transition: label,
        sample: await page.evaluate(() => window.__CITY_PERF__!.samples.at(-1)),
      });
    }
  }
  if (process.env.CITY_STABILITY === "1") {
    const before = await page.evaluate(() => window.__CITY_RENDER__!.inspect());
    const previewDate = await page.getByLabel("Preview local date & time").inputValue();
    // Cross the old unconditional 30-second PMREM refresh while preview time is frozen.
    await page.waitForTimeout(31_000);
    const idle = await page.evaluate(() => window.__CITY_RENDER__!.inspect());
    if (
      idle.environmentTexture !== before.environmentTexture ||
      idle.environmentBakes !== before.environmentBakes
    ) {
      throw new Error("Frozen preview rebuilt the sky environment");
    }
    await page.getByLabel("Preview local date & time").fill("2026-06-21T15:00");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForFunction(
      (count) => window.__CITY_RENDER__!.inspect().environmentBakes > count,
      before.environmentBakes,
    );
    const changed = await page.evaluate(() => window.__CITY_RENDER__!.inspect());
    if (changed.environmentTexture !== before.environmentTexture) {
      throw new Error("Sky update replaced the GPU environment texture");
    }
    results.push({ stability: "passed", before, idle, changed });
    console.log(`${backend}: frozen sky cached, changed sky reuses the same texture`);
    // Restore the requested case before optional lifecycle/device-recovery checks.
    await page.getByLabel("Preview local date & time").fill(previewDate);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForFunction(
      (count) => window.__CITY_RENDER__!.inspect().environmentBakes > count,
      changed.environmentBakes,
    );
  }
  await page.getByLabel("Time zone", { exact: true }).fill("Invalid/Zone");
  await page.getByRole("button", { name: "Apply location" }).click();
  if (!(await page.getByRole("alert").textContent())?.includes("IANA")) {
    throw new Error("Invalid time zone accepted");
  }
  await page.getByRole("button", { name: "Paris", exact: true }).click();
  if (process.env.CITY_LIFECYCLE === "1") {
    const staticCount = await page.evaluate(
      () => window.__CITY_RENDER__!.inspect().sources.filter((s) => s.kind !== "vehicle").length,
    );
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const city of fixtureWorld.cities) {
        await page.getByRole("checkbox", { name: `Show ${city.name}`, exact: true }).uncheck();
      }
      await page.waitForFunction(() =>
        window.__CITY_RENDER__!.inspect().sources.every((s) => s.kind === "vehicle"),
      );
      await page.waitForFunction(() => {
        const sample = window.__CITY_PERF__!.samples.at(-1);
        return (
          sample?.volumePasses === 0 &&
          sample.volumeBlurPasses === 0 &&
          sample.clusteredPointLightVisits === 0
        );
      });
      for (const city of fixtureWorld.cities) {
        await page.getByRole("checkbox", { name: `Show ${city.name}`, exact: true }).check();
      }
      await page.waitForFunction(
        (count) =>
          window.__CITY_RENDER__!.inspect().sources.filter((s) => s.kind !== "vehicle").length ===
          count,
        staticCount,
      );
    }
    results.push({ lifecycle: "passed", staticCount });
  }
  if (process.env.CITY_RECOVERY === "1") {
    const before = await page.evaluate(() => window.__CITY_RENDER__!.inspect());
    await page.evaluate(() => {
      window.__CITY_RENDER__!.simulateDeviceLoss();
    });
    await page.waitForTimeout(1000);
    await page.waitForFunction(
      () => window.__CITY_RENDER__ && (window.__CITY_PERF__?.samples.length ?? 0) > 5,
    );
    const after = await page.evaluate(() => window.__CITY_RENDER__!.inspect());
    if (
      Math.hypot(...after.camera.map((v, i) => v - before.camera[i]!)) > 0.1 ||
      after.night < 0.99
    ) {
      throw new Error("Device recovery lost camera or preview");
    }
    results.push({ recovery: "passed" });
  }
  await page.reload();
  await page.waitForFunction(
    () => window.__CITY_RENDER__ && (window.__CITY_PERF__?.samples.length ?? 0) > 2,
  );
  if ((await lightingSummary(page).textContent())?.includes("Preview")) {
    throw new Error("Preview persisted across reload");
  }
  const location = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("conf-city-solar-location-v1")!),
  );
  if (location.timeZone !== "Europe/Paris") {
    throw new Error("Location was not persisted");
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
} finally {
  await Bun.write(
    `${output}/report.json`,
    JSON.stringify({ backend, software, environment, errors, results }, null, 2),
  );
  await Bun.write(`${output}/world.json`, JSON.stringify(fixtureWorld, null, 2));
  await browser.close();
}
