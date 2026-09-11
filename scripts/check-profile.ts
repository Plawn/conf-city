/** Functional capture check; SwiftShader timings never qualify target-hardware performance. */
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { isQualityTier, QUALITY_PROFILES } from "../src/domain/quality";
import { mergeQualityProfile, parseTweaks } from "../src/domain/qualityOverrides";
import { chromiumArgs } from "./chromium-args";
import { installLightingFixture, previewLighting } from "./lighting-fixture";

const backend = process.env.CITY_BACKEND ?? "webgpu";
const software = process.env.GPU_SOFTWARE === "1";
const output = process.env.CITY_OUTPUT ?? `out/profile/${backend}`;
const params = process.env.CITY_PARAMS ?? "";
const quality = process.env.CITY_QUALITY ?? "eco";
const day = process.env.CITY_CASE === "noon";
// Tweaks decide which passes the pipeline builds, so expect the tier merged with them.
const expected = isQualityTier(quality)
  ? mergeQualityProfile(
      QUALITY_PROFILES[quality],
      parseTweaks(new URLSearchParams(params).get("tweaks")),
    )
  : null;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: chromiumArgs(backend, software),
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.setDefaultTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await installLightingFixture(page);
  const url = `${process.env.CITY_URL ?? "http://127.0.0.1:4175/"}?profile=1&perf=1&idle=0&quality=${quality}&renderer=${backend}${params}`;
  await page.goto(url);
  console.log("Waiting for the 3D pipeline profiler");
  await page.waitForFunction(() => window.__CITY_PROFILE__ && window.__CITY_RENDER__);
  await page.locator("summary").filter({ hasText: "Sun & lighting" }).click();
  await previewLighting(page, day ? "2026-06-21T14:00" : "2026-06-21T01:00");
  await page.locator("summary").filter({ hasText: "Sun & lighting" }).click();
  const warmedFrames = await page.evaluate(() => (window.__CITY_PERF__?.samples.length ?? 0) + 12);
  await page.waitForFunction(
    (count) => (window.__CITY_PERF__?.samples.length ?? 0) >= count,
    warmedFrames,
  );
  await page.getByRole("button", { name: "Record 10 s", exact: true }).click();
  console.log("Recording GPU passes");
  await page.waitForFunction(() => {
    const api = window.__CITY_PROFILE__;
    return api && !api.recording && !api.resolving && api.report().frames.length > 0;
  });
  const report = await page.evaluate(() => window.__CITY_PROFILE__!.report());
  if (report.startedWith.backend !== backend || report.error) {
    throw new Error(`Unexpected backend or capture error: ${JSON.stringify(report)}`);
  }
  if (backend === "webgpu") {
    if (report.summary.completeGpuFrames < 2) {
      throw new Error(`Missing GPU samples: ${JSON.stringify(report.summary)}`);
    }
    const groups = report.summary.groups.map((group) => group.name);
    const required = ["Scene / materials / lighting"];
    if (!params.includes("bloom=0") && (expected?.bloomScale ?? 1) > 0) {
      required.push("Bloom");
    }
    if (!params.includes("localLights=0")) {
      required.push("Light clustering");
    }
    if (day && !params.includes("shadows=0")) {
      required.push("Shadows");
    }
    if (expected?.ao.enabled) {
      required.push("Contact shading");
    }
    for (const name of required) {
      if (!groups.includes(name)) {
        throw new Error(`Missing pass group ${name}: ${groups.join(", ")}`);
      }
    }
    if (
      (params.includes("bloom=0") && groups.includes("Bloom")) ||
      (params.includes("shadows=0") && groups.includes("Shadows"))
    ) {
      throw new Error("A disabled pass still runs");
    }
  } else if (report.summary.completeGpuFrames !== 0) {
    throw new Error("Fallback must not fabricate GPU timestamps");
  }
  await mkdir(output, { recursive: true });
  await Bun.write(`${output}/report.json`, JSON.stringify(report, null, 2));
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  await (await jsonDownload).saveAs(`${output}/download.json`);
  if (report.summary.gpuMeanMs) {
    const flameDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export flamegraph", exact: true }).click();
    await (await flameDownload).saveAs(`${output}/gpu.speedscope.json`);
  }
  await page.screenshot({ path: `${output}/panel.png` });
  // A second capture must discard the first window and resolve fresh pass IDs.
  await page.evaluate(() => window.__CITY_PROFILE__!.start(1500));
  await page.waitForFunction(
    () => !window.__CITY_PROFILE__!.recording && !window.__CITY_PROFILE__!.resolving,
  );
  const second = await page.evaluate(() => window.__CITY_PROFILE__!.report());
  if (!second.frames.length || second.frames[0]!.time <= report.frames.at(-1)!.time) {
    throw new Error("Capture reset retained stale frames");
  }
  await page.goto(url.replace("profile=1&", ""));
  await page.waitForFunction(() => (window.__CITY_PERF__?.samples.length ?? 0) > 5);
  if (
    await page.evaluate(
      () => !!window.__CITY_PROFILE__ || !!document.querySelector("[data-pipeline-profiler]"),
    )
  ) {
    throw new Error("Profiler must be opt-in");
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  console.log(JSON.stringify({ backend, summary: report.summary, errors }, null, 2));
} finally {
  await browser.close();
}
