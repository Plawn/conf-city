import { mkdir, rm } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { chromiumArgs } from "./chromium-args";
import {
  fixtureWorld,
  installLightingFixture,
  loadBenchmarkWorld,
  previewLighting,
} from "./lighting-fixture";

const backend = process.env.CITY_BACKEND ?? "webgpu";
const software = process.env.GPU_SOFTWARE === "1";
const output = process.env.CITY_OUTPUT ?? `out/buildings/${backend}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: chromiumArgs(backend, software),
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
page.setDefaultTimeout(120_000);
const fixture = await installLightingFixture(page);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("favicon")) {
    errors.push(message.text());
  }
});
await page.emulateMedia({ reducedMotion: "reduce" });
const capture = async (name: string) => {
  const data = await page.evaluate(() => window.__CITY_RENDER__!.capture());
  await Bun.write(`${output}/${name}.png`, Buffer.from(data.split(",")[1]!, "base64"));
};
try {
  await page.goto(`${process.env.CITY_URL ?? "http://127.0.0.1:4174/"}?perf=1&renderer=${backend}`);
  await page.waitForFunction(() => (window.__CITY_RENDER__?.inspect().buildings.length ?? 0) > 0);
  await loadBenchmarkWorld(page);
  await page.locator("summary").filter({ hasText: "Sun & lighting" }).click();
  await previewLighting(page, "2026-06-21T14:00");
  await page.locator("summary").filter({ hasText: "Sun & lighting" }).click();
  // A frozen preview and unchanged telemetry must let all building tasks settle.
  await page.waitForFunction(() => {
    const frames = window.__CITY_PERF__!.samples.slice(-5);
    return (
      frames.length === 5 &&
      frames.every(
        (frame) => frame.buildingAnimationVisits === 0 && frame.buildingInstanceWrites === 0,
      )
    );
  });
  const initial = await page.evaluate(() => window.__CITY_RENDER__!.inspect());
  const target = initial.buildings[0]!;
  console.log(`${backend}: idle passed, target ${target.id}, height ${target.height}`);
  const graphNode = fixtureWorld.cities
    .flatMap((city) => city.nodes.map((node) => ({ ...node, address: `${city.id}/${node.id}` })))
    .find((node) => node.address === target.id)!;
  await page.evaluate((id) => {
    const api = window.__CITY_RENDER__!;
    const building = api.inspect().buildings.find((entry) => entry.id === id)!;
    const [x, y, z] = building.position;
    api.focus([x! + 8, y! + 9, z! + 12], [x!, y!, z!]);
  }, target.id);
  await page.waitForTimeout(2000);
  const screen = await page.evaluate(
    (id) => window.__CITY_RENDER__!.inspect().buildings.find((entry) => entry.id === id)!.screen,
    target.id,
  );
  await page.mouse.move(screen[0]!, screen[1]!);
  await expect(page.getByText(graphNode.label, { exact: true }).last()).toBeVisible();
  await page.mouse.click(screen[0]!, screen[1]!);
  await expect(page.getByText(target.id, { exact: true })).toBeVisible();
  await capture("selected");
  console.log(`${backend}: pointer selection passed`);
  await page.keyboard.press("Escape");
  await page.mouse.move(790, 490);
  fixture.setNode(target.id, { metrics: { memoryMb: 0, errorRate: 0.2 } });
  await page.waitForFunction(
    ({ id, height }) => {
      const building = window.__CITY_RENDER__!.inspect().buildings.find((entry) => entry.id === id);
      return building && building.height < height * 0.95;
    },
    { id: target.id, height: target.height },
  );
  await capture("incident");
  console.log(`${backend}: telemetry transition passed`);
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await capture("memory");
  await page.getByRole("tab", { name: "Health", exact: true }).click();
  fixture.setNode(target.id, {});
  await page.waitForFunction(() =>
    window.__CITY_PERF__!.samples.slice(-3).every((frame) => frame.buildingAnimationVisits === 0),
  );

  // Removing from the static world leaves a telemetry-discovered transparent building.
  const removed = structuredClone(fixtureWorld);
  const [cityId, nodeId] = target.id.split("/");
  for (const city of removed.cities) {
    if (city.id === cityId) {
      city.nodes = city.nodes
        .filter((node) => node.id !== nodeId)
        .map((node) => ({ ...node, links: node.links.filter((link) => link !== nodeId) }));
    }
  }
  removed.links = removed.links?.filter((link) => link.from !== target.id && link.to !== target.id);
  const load = async (world: typeof fixtureWorld) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: "world.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(world)),
    });
  };
  await load(removed);
  await page.waitForFunction(
    (id) => !window.__CITY_RENDER__!.inspect().buildings.some((entry) => entry.id === id),
    target.id,
  );
  await capture("discovered");
  await load(fixtureWorld);
  await page.waitForFunction(
    (id) => window.__CITY_RENDER__!.inspect().buildings.some((entry) => entry.id === id),
    target.id,
  );
  const port = structuredClone(fixtureWorld);
  port.cities
    .find((city) => city.id === cityId)!
    .nodes.find((node) => node.id === nodeId)!.ingress = true;
  await load(port);
  await page.waitForFunction(
    (id) => !window.__CITY_RENDER__!.inspect().buildings.some((entry) => entry.id === id),
    target.id,
  );
  await capture("port");
  await load(fixtureWorld);
  await page.waitForFunction(
    (count) => window.__CITY_RENDER__!.inspect().buildings.length === count,
    initial.buildings.length,
  );
  expect(errors).toEqual([]);
  await Bun.write(
    `${output}/report.json`,
    JSON.stringify(
      {
        backend,
        software,
        initial,
        final: await page.evaluate(() => window.__CITY_RENDER__!.inspect()),
        errors,
      },
      null,
      2,
    ),
  );
  await rm(`${output}/failure.json`, { force: true });
  console.log(
    `${backend}: idle, pointer selection, telemetry, heatmap, discovery, port and restoration passed`,
  );
} catch (error) {
  await Bun.write(
    `${output}/failure.json`,
    JSON.stringify(
      {
        error: String(error),
        errors,
        state: await page.evaluate(() => window.__CITY_RENDER__?.inspect()).catch(() => null),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
