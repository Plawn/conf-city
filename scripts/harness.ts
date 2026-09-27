// Shared setup for the headless checks: env, Chromium launch, page wiring, report helpers.
import { mkdir } from "node:fs/promises";
import { type Browser, chromium, type Page } from "@playwright/test";
import {
  benchmarkDpr,
  benchmarkRenderMode,
  benchmarkViewport,
  fixtureWorld,
  installLightingFixture,
} from "./lighting-fixture";

/** The production preview every check runs against (`bun run preview --port 4174`). */
export const cityUrl = process.env.CITY_URL ?? "http://127.0.0.1:4174/";

/** `CITY_PARAMS`, forced to the `high` tier (the old fixed budgets) unless it names one. */
export function benchmarkParams(): string {
  const params = process.env.CITY_PARAMS ?? "";
  return `${params}${/quality=/.test(params) ? "" : "&quality=high"}`;
}

/** Chromium flags for the headless checks: SwiftShader for CI, the Vulkan adapter otherwise. */
export function chromiumArgs(backend: string, software: boolean): string[] {
  const vulkan = ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface"];
  if (!software) {
    // Without these Linux headless Chromium silently falls back to SwiftShader on both backends.
    return ["--no-sandbox", "--enable-unsafe-webgpu", ...vulkan];
  }
  return [
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    ...(backend === "webgl"
      ? ["--use-angle=swiftshader"]
      : ["--use-vulkan=swiftshader", ...vulkan]),
  ];
}

/** `CITY_OUTPUT`, or `fallback`, created if missing. */
export async function outputDir(fallback: string): Promise<string> {
  const output = process.env.CITY_OUTPUT ?? fallback;
  await mkdir(output, { recursive: true });
  return output;
}

export interface CheckViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/**
 * Launch Chromium for check `name` (output defaults to `out/<name>/<backend>`) with one page:
 * 120 s timeouts, favicon stubbed, page errors collected into `errors`, lighting fixture installed.
 */
export async function launchCheck(name: string, viewport: CheckViewport) {
  const backend = process.env.CITY_BACKEND ?? "webgpu";
  const software = process.env.GPU_SOFTWARE === "1";
  const output = await outputDir(`out/${name}/${backend}`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: chromiumArgs(backend, software),
  });
  const { deviceScaleFactor = 1, ...size } = viewport;
  const page = await browser.newPage({ viewport: size, deviceScaleFactor });
  page.setDefaultTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  const fixture = await installLightingFixture(page);
  return { backend, software, output, browser, page, errors, fixture };
}

/** The benchmark viewport, as `launchCheck` takes it. */
export const benchmarkPage: CheckViewport = {
  ...benchmarkViewport,
  deviceScaleFactor: benchmarkDpr,
};

/** What a benchmark report records about the run; `adapter` is filled once the page reports it. */
export function benchmarkEnvironment(browser: Browser, params: string) {
  return {
    browser: browser.version(),
    viewport: benchmarkViewport,
    dpr: benchmarkDpr,
    world: {
      cities: fixtureWorld.cities.length,
      nodes: fixtureWorld.cities.reduce((sum, city) => sum + city.nodes.length, 0),
    },
    renderMode: benchmarkRenderMode,
    params,
    adapter: {} as object,
  };
}

/** The page's GPU adapter; a budget run (`CITY_ASSERT_BUDGET` / `CITY_ASSERT_60`) must be real hardware. */
export async function assertHardwareAdapter(page: Page, software: boolean): Promise<object> {
  const adapter: object = await page.evaluate(() => window.__CITY_PERF__!.adapter ?? {});
  if (
    (process.env.CITY_ASSERT_BUDGET === "1" || process.env.CITY_ASSERT_60 === "1") &&
    (software || !("isFallbackAdapter" in adapter) || adapter.isFallbackAdapter !== false)
  ) {
    throw new Error("Hardware qualification requires a verified hardware rendering adapter");
  }
  return adapter;
}

/** Write a `data:image/png;base64,…` URL to `path`. */
export function savePng(dataUrl: string, path: string) {
  return Bun.write(path, Buffer.from(dataUrl.split(",")[1]!, "base64"));
}

/** The "Sun & lighting" disclosure of the settings panel. */
export function lightingSummary(page: Page) {
  return page.locator("summary").filter({ hasText: "Sun & lighting" });
}

/** Open the lighting panel, run `fn`, close it again. */
export async function withLightingPanel<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await lightingSummary(page).click();
  const result = await fn();
  await lightingSummary(page).click();
  return result;
}
