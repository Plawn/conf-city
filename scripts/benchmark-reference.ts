// Uncapped frame cadence of Conf City vs an external reference (Threejs-Punk), same browser and viewport.
// Usage: CITY_REFERENCE=punk|city [CITY_CASE=noon|night] bun scripts/benchmark-reference.ts
import { chromium, type Page } from "@playwright/test";
import { percentile } from "../src/lib/stats";
import { chromiumArgs, cityUrl, outputDir, withLightingPanel } from "./harness";
import {
  benchmarkViewport,
  installLightingFixture,
  lightingCases,
  loadBenchmarkWorld,
  previewLighting,
} from "./lighting-fixture";

const PUNK_URL = process.env.PUNK_URL ?? "https://threejspunk.vercel.app/";
const target = process.env.CITY_REFERENCE ?? "punk";
const duration = Number(process.env.CITY_DURATION_MS ?? 10_000);
const warmup = Number(process.env.CITY_WARMUP_MS ?? 8_000);
const output = await outputDir(`out/reference/${target}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  // Uncapped rAF so both scenes show their headroom instead of the 60 Hz vsync.
  args: [...chromiumArgs("webgpu", false), "--disable-gpu-vsync", "--disable-frame-rate-limit"],
});
const page = await browser.newPage({ viewport: benchmarkViewport, deviceScaleFactor: 1 });
page.setDefaultTimeout(180_000);
page.on("pageerror", (error) => console.error(error.message));

/** rAF intervals over `ms`, plus the canvas backing size. */
async function sample(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<{ intervals: number[]; canvas: string }>((resolve) => {
        const intervals: number[] = [];
        let last = performance.now();
        const end = last + ms;
        const tick = (now: number) => {
          intervals.push(now - last);
          last = now;
          if (now < end) {
            requestAnimationFrame(tick);
          } else {
            const c = document.querySelector("canvas");
            resolve({ intervals, canvas: c ? `${c.width}x${c.height}` : "none" });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/** Click the first visible enabled button whose text matches, waiting up to `ms`. */
async function clickWhenReady(page: Page, label: RegExp, ms: number) {
  const button = page.getByRole("button", { name: label }).first();
  await button.waitFor({ state: "visible", timeout: ms });
  await page.waitForFunction(
    (source) =>
      [...document.querySelectorAll("button")].some(
        (b) => new RegExp(source, "i").test(b.textContent ?? "") && !b.disabled,
      ),
    label.source,
    { timeout: ms },
  );
  await button.click();
}

let label = target;
if (target === "punk") {
  await page.goto(PUNK_URL);
  await clickWhenReady(page, /enter/i, 180_000);
  await page.waitForTimeout(3000);
  // The briefing screen ends on "Let's ride"; older builds go straight to the game.
  await clickWhenReady(page, /ride/i, 30_000).catch(() => console.warn("no ride button"));
} else {
  await installLightingFixture(page);
  const tweaks = process.env.CITY_TWEAKS ? `&tweaks=${process.env.CITY_TWEAKS}` : "";
  await page.goto(`${cityUrl}?quality=high&idle=0&fps=1000&perf=1&renderer=webgpu${tweaks}`);
  await loadBenchmarkWorld(page);
  const caseName = process.env.CITY_CASE ?? "night";
  const date = lightingCases.find(([name]) => name === caseName)?.[1];
  if (!date) {
    throw new Error(`unknown CITY_CASE ${caseName}`);
  }
  await withLightingPanel(page, () => previewLighting(page, date));
  label = `${target}-${caseName}${process.env.CITY_TWEAKS ? `-${process.env.CITY_TWEAKS}` : ""}`;
}
await page.waitForTimeout(warmup);
await page.screenshot({ path: `${output}/${label}.png` });
const started = await page.evaluate(() => performance.now());
const { intervals: rafIntervals, canvas } = await sample(page, duration);
// rAF keeps ticking while the render loop skips frames with two in flight, so count rendered frames.
const intervals =
  target === "punk"
    ? rafIntervals
    : await page.evaluate(
        (since) =>
          window.__CITY_PERF__!.samples.filter((s) => s.time > since).map((s) => s.intervalMs),
        started,
      );
const sorted = intervals.slice(1).sort((a, b) => a - b);
const median = percentile(sorted, 0.5);
const report = {
  target: label,
  canvas,
  frames: sorted.length,
  fps: Math.round((sorted.length * 1000) / duration),
  medianMs: +median.toFixed(2),
  p95Ms: +percentile(sorted, 0.95).toFixed(2),
};
console.log(JSON.stringify(report));
await Bun.write(`${output}/${label}.json`, JSON.stringify(report, null, 2));
await browser.close();
