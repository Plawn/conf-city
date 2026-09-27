/**
 * Top-down map of every city's road geometry, built by the real `buildRoadGeometry` from a proxy
 * snapshot, rendered to PNG through Chromium. `bun scripts/road-map.ts [snapshot.json] [outDir]`;
 * no argument fetches a live snapshot from `PROXY_URL` (default the deployed cluster).
 * Needs `CHROMIUM_PATH` like the other headless scripts.
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import type * as THREE from "three";
import { buildRoadGeometry } from "../src/components/roads/buildRoadGeometry";
import { resolveBiomes } from "../src/domain/biome";
import type { CityMeta, NodeMeta, World } from "../src/domain/types";
import { deckExits } from "../src/geo/bridgeScene";
import { bridgeDeck, DECK_CLASS, deckWidth } from "../src/geo/drivable";
import { buildRoadGraph } from "../src/geo/roadGraph";
import { layoutWorld } from "../src/layout/layoutWorld";
import type { Vec2 } from "../src/layout/types";
import { buildDiscoveredNodes } from "../src/loaders/buildDiscoveredNodes";
import { loadWorld } from "../src/loaders/loadWorld";
import { EMPTY_INFRA } from "../src/store/mobilityStore";

const PX_PER_UNIT = 24;

async function snapshot(path: string | undefined) {
  if (path) {
    return JSON.parse(await Bun.file(path).text());
  }
  const url = process.env.PROXY_URL ?? "wss://city.konf.sh/ws/frontend";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`no snapshot from ${url}`)), 15000);
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "snapshot") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    };
  });
}

// biome-ignore lint/suspicious/noExplicitAny: raw proxy JSON
const snap: any = await snapshot(Bun.argv[2]);
const outDir = Bun.argv[3] ?? "out/road-map";
await mkdir(outDir, { recursive: true });

const world: World = { cities: [] };
const { nodes: staticNodes, links: staticLinks } = loadWorld(world);
const nodeMeta = new Map<string, NodeMeta>(Object.entries(snap.meta ?? {}));
const cityMeta = new Map<string, CityMeta>(Object.entries(snap.cityMeta ?? {}));
const discovered = buildDiscoveredNodes(
  new Set(Object.keys(snap.nodes)),
  new Set(),
  world.cities,
  nodeMeta,
);
const cityIds = discovered.cities.map((c) => c.id);
const allCities = discovered.cities.map((c) => ({ id: c.id, name: c.name, nodes: [] }));
const biomes = resolveBiomes(allCities, discovered.nodes, cityMeta);
const ingress = new Set<string>();
for (const n of discovered.nodes) {
  const addr = `${n.cityId}/${n.id}`;
  if (nodeMeta.get(addr)?.ingress ?? n.ingress) {
    ingress.add(addr);
  }
}
const capacities = new Map<string, number>();
for (const [id, m] of cityMeta) {
  if (m.memMb) {
    capacities.set(id, m.memMb);
  }
}
const layout = layoutWorld(
  cityIds,
  staticNodes,
  [...staticLinks, ...discovered.links],
  discovered.nodes,
  biomes,
  ingress,
  capacities,
);
const exits = deckExits(layout, EMPTY_INFRA);

/** Every triangle of `g` projected on the ground plane, as SVG polygons of one fill. */
function trianglesSvg(g: THREE.BufferGeometry | null, fill: string): string {
  if (!g) {
    return "";
  }
  const pos = g.getAttribute("position");
  const index = g.getIndex();
  const count = index ? index.count : pos.count;
  const vertex = (k: number) => (index ? index.getX(k) : k);
  let out = "";
  for (let k = 0; k + 2 < count; k += 3) {
    const pts = [vertex(k), vertex(k + 1), vertex(k + 2)].map(
      (v) => `${pos.getX(v).toFixed(3)},${pos.getZ(v).toFixed(3)}`,
    );
    out += `<polygon points="${pts.join(" ")}"/>`;
  }
  // A hairline stroke of the same colour hides the anti-aliasing seams between triangles.
  return `<g fill="${fill}" stroke="${fill}" stroke-width="0.006">${out}</g>`;
}

const CROP = Number(process.env.CROP ?? 9);
const CROP_PX = Number(process.env.CROP_PX ?? 360);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage();

for (const [id, city] of layout.cities) {
  const { roads } = city;
  const cityExits = exits.get(id) ?? [];
  const geo = buildRoadGeometry(roads.segments, roads.roundabouts, roads.driveways, cityExits);
  const graph = buildRoadGraph(
    roads.segments,
    roads.roundabouts,
    roads.driveways.map((d) => d.mouth),
    cityExits,
  );
  const xs = city.outline.map((p) => p[0]);
  const zs = city.outline.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const w = x1 - x0;
  const h = z1 - z0;
  const decks = layout.bridges
    .filter((b) => b.cityA === id || b.cityB === id)
    .map((b) => {
      const [a, c] = bridgeDeck(b.waterSpan, [
        ...(layout.cities.get(b.cityA)?.roads.roundabouts ?? []),
        ...(layout.cities.get(b.cityB)?.roads.roundabouts ?? []),
      ]);
      const half = deckWidth(DECK_CLASS) / 2;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const n: Vec2 = [(-(c[1] - a[1]) / len) * half, ((c[0] - a[0]) / len) * half];
      const quad = [
        [a[0] + n[0], a[1] + n[1]],
        [c[0] + n[0], c[1] + n[1]],
        [c[0] - n[0], c[1] - n[1]],
        [a[0] - n[0], a[1] - n[1]],
      ];
      return `<polygon points="${quad.map((p) => p.join(",")).join(" ")}" fill="#6a5acd"/>`;
    })
    .join("");
  const buildings = city.nodes
    .map((n) => `<circle cx="${n.position[0]}" cy="${n.position[2]}" r="0.9" fill="#b07040"/>`)
    .join("");
  const body = `<polygon points="${city.outline.map((p) => p.join(",")).join(" ")}" fill="#4d7a3a"/>
${trianglesSvg(geo.asphalt, "#303030")}
${trianglesSvg(geo.markings, "#f0f0f0")}
${trianglesSvg(geo.pavement, "#a8a8a8")}
${trianglesSvg(geo.islands, "#1f5f1f")}
${decks}${buildings}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${z0} ${w} ${h}" width="${Math.ceil(w * PX_PER_UNIT)}" height="${Math.ceil(h * PX_PER_UNIT)}">${body}</svg>`;
  await page.setViewportSize({
    width: Math.ceil(w * PX_PER_UNIT),
    height: Math.ceil(h * PX_PER_UNIT),
  });
  await page.setContent(`<body style="margin:0;background:#1b4a6b">${svg}</body>`);
  await page.screenshot({ path: `${outDir}/${id}.png` });

  // Close-ups: every roundabout, crossing and class change, on one contact sheet.
  const spots = graph.nodes.filter(
    (n) =>
      n.kind === "roundabout" ||
      n.arms.length >= 3 ||
      (n.arms.length === 2 && n.arms[0]!.klass !== n.arms[1]!.klass),
  );
  const cols = 4;
  const rows = Math.ceil(spots.length / cols);
  const tiles = spots
    .map((n, k) => {
      const [cx, cz] = n.pos;
      const label = `${n.kind} ${n.arms.map((a) => a.klass[0]).join("")}`;
      return `<svg x="${(k % cols) * CROP_PX}" y="${Math.floor(k / cols) * CROP_PX}" width="${CROP_PX}" height="${CROP_PX}" viewBox="${cx - CROP / 2} ${cz - CROP / 2} ${CROP} ${CROP}"><rect x="${cx - CROP}" y="${cz - CROP}" width="${2 * CROP}" height="${2 * CROP}" fill="#1b4a6b"/>${body}<text x="${cx - CROP / 2 + 0.2}" y="${cz - CROP / 2 + 0.6}" font-size="0.5" fill="#ff0">${k} ${label}</text></svg>`;
    })
    .join("");
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * CROP_PX}" height="${rows * CROP_PX}">${tiles}</svg>`;
  await page.setViewportSize({ width: cols * CROP_PX, height: Math.max(1, rows * CROP_PX) });
  await page.setContent(`<body style="margin:0;background:#000">${sheet}</body>`);
  await page.screenshot({ path: `${outDir}/${id}-spots.png` });
  console.log(
    `${outDir}/${id}.png: ${roads.segments.length} segments, ${roads.roundabouts.length} roundabouts, ${roads.driveways.length} driveways, ${spots.length} spots`,
  );
}
await browser.close();
