import { clearInterval, setInterval } from "node:timers";
import type { Page } from "@playwright/test";
import sample from "../src/data/sample.json";
import type { NodeTelemetry, World } from "../src/domain/types";
import { loadWorld } from "../src/loaders/loadWorld";

const sourceWorld: World = process.env.CITY_WORLD
  ? await Bun.file(process.env.CITY_WORLD).json()
  : (sample as World);
const scale = Number(process.env.CITY_WORLD_SCALE ?? 1);
if (!Number.isInteger(scale) || scale < 1) {
  throw new Error("CITY_WORLD_SCALE must be a positive integer");
}
loadWorld(sourceWorld);
const suffix = (copy: number) => (copy === 0 ? "" : `-bench-${copy}`);
export const fixtureWorld: World = {
  cities: sourceWorld.cities.map((city) => ({
    ...city,
    nodes: Array.from({ length: scale }, (_, copy) =>
      city.nodes.map((node) => ({
        ...node,
        id: node.id + suffix(copy),
        label: node.label + suffix(copy),
        links: node.links.map((target) => target + suffix(copy)),
      })),
    ).flat(),
  })),
  links: Array.from({ length: scale }, (_, copy) =>
    (sourceWorld.links ?? []).map((link) => ({
      ...link,
      from: link.from + suffix(copy),
      to: link.to + suffix(copy),
    })),
  ).flat(),
};
loadWorld(fixtureWorld);
const customWorld = !!process.env.CITY_WORLD || scale !== 1;
const activateWorld = new WeakMap<Page, () => void>();

export async function loadBenchmarkWorld(page: Page) {
  if (!customWorld) {
    return;
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: "benchmark-world.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixtureWorld)),
  });
  await page.getByText("World loaded", { exact: true }).waitFor();
  activateWorld.get(page)!();
  await page.waitForTimeout(3000);
}

/** Shared workload for lighting and camera comparisons, isolated from the real proxy. */
export async function installLightingFixture(page: Page) {
  const overrides = new Map<string, Partial<NodeTelemetry>>();
  const senders = new Set<() => void>();
  // Do not discover the stress world's services inside the sample before its JSON is loaded.
  let configured = !customWorld;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      configured = !customWorld;
    }
  });
  activateWorld.set(page, () => {
    configured = true;
    for (const send of senders) {
      send();
    }
  });
  await page.addInitScript((mode) => {
    localStorage.setItem("conf-city-render-mode", mode);
  }, benchmarkRenderMode);
  await page.routeWebSocket(/\/ws\/frontend/, (socket) => {
    const send = () => {
      const now = Date.now();
      const cities = configured ? fixtureWorld.cities : [];
      const snapshot = JSON.stringify({
        type: "snapshot",
        timestamp: now,
        nodes: Object.fromEntries(
          cities.flatMap((city) =>
            city.nodes.map((node) => [
              `${city.id}/${node.id}`,
              {
                liveness: "healthy",
                lastSeen: now,
                ...overrides.get(`${city.id}/${node.id}`),
                metrics: {
                  cpu: 35,
                  memoryMb: 768,
                  rps: 80,
                  latencyMs: 25,
                  errorRate: 0,
                  netRxKbps: 800,
                  netTxKbps: 500,
                  ...overrides.get(`${city.id}/${node.id}`)?.metrics,
                },
              },
            ]),
          ),
        ),
        cityMeta: Object.fromEntries(
          cities.map((city) => [city.id, { cpuCores: 8, memMb: 16000 }]),
        ),
        cityMetrics: configured
          ? {
              "paris-1": {
                cpuUsedCores: 2.8,
                memUsedMb: 6000,
                diskUsedMb: 40000,
                diskTotalMb: 100000,
                at: now,
              },
            }
          : {},
      });
      socket.send(snapshot);
    };
    senders.add(send);
    send();
    // A 30-second measurement must not silently lose traffic to stale telemetry.
    const timer = setInterval(send, 5000);
    timer.unref();
    const stop = () => {
      senders.delete(send);
      clearInterval(timer);
      page.off("close", stop);
    };
    socket.onMessage(send);
    socket.onClose(stop);
    page.once("close", stop);
  });
  return {
    setNode: (address: string, telemetry: Partial<NodeTelemetry>) => {
      overrides.set(address, telemetry);
      for (const send of senders) {
        send();
      }
    },
  };
}

export const lightingCases = [
  ["noon", "2026-06-21T14:00"],
  ["dawn", "2026-06-21T05:45"],
  ["night", "2026-06-21T01:00"],
] as const;

export const benchmarkViewport = {
  width: Number(process.env.CITY_WIDTH ?? 960),
  height: Number(process.env.CITY_HEIGHT ?? 600),
};
export const benchmarkDpr = Number(process.env.CITY_DPR ?? 1);
export const benchmarkRenderMode = process.env.CITY_RENDER_MODE ?? "smooth";
if (benchmarkRenderMode !== "office" && benchmarkRenderMode !== "smooth") {
  throw new Error("CITY_RENDER_MODE must be office or smooth");
}
export const benchmarkFrameBudget = benchmarkRenderMode === "office" ? 35 : 18;
export const benchmarkDuration = Number(
  process.env.CITY_DURATION_MS ?? (process.env.GPU_SOFTWARE === "1" ? 2000 : 30_000),
);

export async function previewLighting(page: Page, date: string) {
  await page.getByLabel("Preview local date & time").fill(date);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.waitForTimeout(3000);
}
