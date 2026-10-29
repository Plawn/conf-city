// Reproduce the cached shadow-texture failure across repeated quality changes.
process.env.CITY_RENDER_MODE ??= "office";
process.env.CITY_WIDTH ??= "1280";
process.env.CITY_HEIGHT ??= "800";
const {
  assertHardwareAdapter,
  benchmarkEnvironment,
  benchmarkPage,
  cityUrl,
  launchCheck,
  savePng,
  withLightingPanel,
} = await import("./harness");
const { lightingCases, loadBenchmarkWorld, previewLighting } = await import("./lighting-fixture");
const { page, browser, output, errors, backend, software } = await launchCheck(
  "shadow-lifecycle",
  benchmarkPage,
);
const results: object[] = [];
const metadata = {
  ...benchmarkEnvironment(browser, "&quality=high&tweaks="),
  buildAssets: [] as string[],
};
async function check(label: string, tier: string, night: boolean) {
  await page.waitForFunction((tier) => window.__CITY_PERF__?.quality.tier === tier, tier);
  await page.waitForTimeout(1000);
  const lastTime = await page.evaluate(() => window.__CITY_PERF__!.samples.at(-1)?.time ?? 0);
  await page.waitForFunction(
    (time) => (window.__CITY_PERF__!.samples.at(-1)?.time ?? 0) > time + 100,
    lastTime,
  );
  const state = await page.evaluate(() => ({
    scene: window.__CITY_RENDER__!.inspect(),
    sample: window.__CITY_PERF__!.samples.at(-1),
  }));
  if (errors.length) {
    throw new Error(`${label}: ${errors.join("\n")}`);
  }
  const expectedSamples = tier === "eco" ? 0 : tier === "high" && backend === "webgpu" ? 16 : 8;
  if (state.scene.ao.samples !== expectedSamples || state.scene.ao.enabled !== (tier !== "eco")) {
    throw new Error(`${label}: quality transition did not rebuild AO`);
  }
  if (night && (state.scene.night < 0.99 || state.scene.beacon <= 0)) {
    throw new Error(`${label}: the replacement lighthouse is not active`);
  }
  await savePng(
    await page.evaluate(() => window.__CITY_RENDER__!.capture()),
    `${output}/${label}.png`,
  );
  results.push({ label, ...state });
  console.log(`${label}: ${tier}, lighthouse ${state.scene.beacon.toFixed(2)}`);
}
try {
  await page.goto(`${cityUrl}?perf=1&idle=0&quality=high&tweaks=&renderer=${backend}`);
  await page.waitForFunction(() => window.__CITY_RENDER__ && window.__CITY_PERF__);
  metadata.buildAssets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement>('script[type="module"]')].map(
      (script) => script.src,
    ),
  );
  await loadBenchmarkWorld(page);
  metadata.adapter = await assertHardwareAdapter(page, software);
  await page.keyboard.press("f");
  for (const [name, date] of lightingCases.filter(([name]) => name !== "dawn")) {
    await withLightingPanel(page, () => previewLighting(page, date));
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [step, tier] of ["High", "Eco", "Balanced", "High"].entries()) {
        await page.getByRole("tab", { name: tier, exact: true }).click();
        await check(
          `${name}-${cycle}-${step}-${tier.toLowerCase()}`,
          tier.toLowerCase(),
          name === "night",
        );
      }
    }
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    for (const viewport of [
      { width: 1279, height: 799 },
      { width: 960, height: 600 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await check(`${name}-resize-${viewport.width}`, "high", name === "night");
    }
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
} finally {
  await Bun.write(
    `${output}/report.json`,
    JSON.stringify({ metadata, backend, results, errors }, null, 2),
  );
  await browser.close();
}
