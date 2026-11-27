/**
 * Placement quality of every city from a proxy snapshot: an ASCII map of the lattice (one letter
 * per neighbourhood) and the numbers a better placement should lower — link length in cells,
 * neighbourhood spread, bounding box. `bun scripts/layout-metrics.ts <snapshot.json>`.
 */
import { resolveBiomes } from "../src/domain/biome";
import type { CityMeta, NodeMeta, World } from "../src/domain/types";
import { PITCH } from "../src/layout/constants";
import { layoutWorld } from "../src/layout/layoutWorld";
import { buildDiscoveredNodes } from "../src/loaders/buildDiscoveredNodes";
import { loadWorld } from "../src/loaders/loadWorld";

// biome-ignore lint/suspicious/noExplicitAny: raw proxy JSON
const snap: any = JSON.parse(await Bun.file(Bun.argv[2] ?? "out/road-map/snapshot.json").text());
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
const biomes = resolveBiomes(
  discovered.cities.map((c) => ({ id: c.id, name: c.name, nodes: [] })),
  discovered.nodes,
  cityMeta,
);
const ingress = new Set<string>();
for (const n of discovered.nodes) {
  if (nodeMeta.get(`${n.cityId}/${n.id}`)?.ingress ?? n.ingress) {
    ingress.add(`${n.cityId}/${n.id}`);
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

const allLinks = [...staticLinks, ...discovered.links];
for (const city of layout.cities.values()) {
  if (city.cloud) {
    continue;
  }
  const cells = new Map<string, [number, number]>();
  for (const n of city.nodes) {
    if (n.isPort) {
      continue;
    }
    cells.set(n.id, [
      Math.round((n.position[0] - city.center[0]) / PITCH),
      Math.round((n.position[2] - city.center[1]) / PITCH),
    ]);
  }
  const groups = [...new Set(city.nodes.map((n) => n.group ?? "-"))].sort();
  const letter = (g: string) => (g === "-" ? "·" : String.fromCharCode(65 + groups.indexOf(g)));
  const at = new Map<string, string>();
  for (const n of city.nodes) {
    const c = cells.get(n.id);
    if (c) {
      at.set(`${c[0]},${c[1]}`, letter(n.group ?? "-"));
    }
  }
  const all = [...cells.values()];
  const is = all.map((c) => c[0]);
  const js = all.map((c) => c[1]);
  const [i0, i1, j0, j1] = [Math.min(...is), Math.max(...is), Math.min(...js), Math.max(...js)];
  let linkLen = 0;
  let links = 0;
  for (const l of allLinks.filter((l) => !l.interCity && l.fromCityId === city.cityId)) {
    const a = cells.get(l.fromNodeId);
    const b = cells.get(l.toNodeId);
    if (a && b) {
      linkLen += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      links++;
    }
  }
  let spread = 0;
  for (const g of groups) {
    const m = city.nodes
      .filter((n) => !n.isPort && (n.group ?? "-") === g && g !== "-")
      .map((n) => cells.get(n.id)!);
    if (m.length < 2) {
      continue;
    }
    const ci = m.reduce((s, c) => s + c[0], 0) / m.length;
    const cj = m.reduce((s, c) => s + c[1], 0) / m.length;
    spread += m.reduce((s, c) => s + Math.abs(c[0] - ci) + Math.abs(c[1] - cj), 0);
  }
  console.log(
    `\n${city.cityId}: ${city.nodes.length} buildings, ${links} links, link length ${linkLen} cells, group spread ${spread.toFixed(1)}, box ${i1 - i0 + 1}x${j1 - j0 + 1}`,
  );
  console.log(`  groups: ${groups.map((g) => `${letter(g)}=${g}`).join(" ")}`);
  for (let j = j0; j <= j1; j++) {
    let row = "  ";
    for (let i = i0; i <= i1; i++) {
      row += ` ${at.get(`${i},${j}`) ?? " "}`;
    }
    console.log(row);
  }
}
