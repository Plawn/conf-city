/** Camera director metrics: `bun scripts/check-shots.ts <scenario.json>` prints each shot and the totals. */
import { readFileSync } from "node:fs";
import { resolveBiomes } from "../src/domain/biome";
import { planShots } from "../src/domain/director";
import { nodeAddress } from "../src/domain/nodeStyle";
import { parseScenario } from "../src/domain/scenario";
import { assembleWorld, planWorld } from "../src/layout/layoutWorld";
import type { WorldLayout } from "../src/layout/types";
import { loadWorld } from "../src/loaders/loadWorld";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/check-shots.ts <scenario.json>");
  process.exit(1);
}
const tl = parseScenario(JSON.parse(readFileSync(file, "utf8")));
const { nodes } = loadWorld(tl.world);
const biomes = resolveBiomes(tl.world.cities, nodes, tl.cityMeta);
const capacities = new Map<string, number>();
for (const [id, m] of tl.cityMeta) {
  if (m.memMb != null && m.memMb > 0) {
    capacities.set(id, m.memMb);
  }
}
const ingress = new Set(nodes.filter((n) => n.ingress).map(nodeAddress));
const clouds = new Set(tl.world.cities.filter((c) => c.cloud).map((c) => c.id));
const layout = assembleWorld(
  planWorld(
    tl.world.cities.map((c) => c.id),
    nodes,
    tl.links,
    [],
    biomes,
    ingress,
    capacities,
    clouds,
  ),
);
const shots = planShots(tl, layout);

/** Cities alive during the hold whose centre lies in the square `frame()` sized `distance` for; "wide" when most do. */
function subject(
  layout: WorldLayout,
  lookAt: [number, number, number],
  distance: number,
  from: number,
  to: number,
): string {
  const half = Math.max(2, distance / 1.05 - 10) / 2;
  const inside: string[] = [];
  let nearest = "";
  let best = Number.POSITIVE_INFINITY;
  for (const [id, c] of layout.cities) {
    const span = tl.cities.get(id);
    if (!span || span.from >= to || span.to <= from) {
      continue;
    }
    const dx = Math.abs(c.center[0] - lookAt[0]);
    const dz = Math.abs(c.center[1] - lookAt[2]);
    if (Math.hypot(dx, dz) < best) {
      best = Math.hypot(dx, dz);
      nearest = id;
    }
    if (dx <= half && dz <= half) {
      inside.push(id);
    }
  }
  const list = inside.length > 0 ? inside : [`near ${nearest}`];
  const where =
    list.length >= Math.max(3, layout.cities.size * 0.6)
      ? `wide (${list.length} cities)`
      : list.join(", ");
  return lookAt[1] > 1 ? `${where} @y${lookAt[1].toFixed(0)}` : where;
}

const total = tl.totalSec;
const holds: number[] = [];
let moving = 0;
console.log(` #   start   land   move  hold   dist  frames`);
shots.forEach((s, i) => {
  const land = i === 0 ? s.t : s.t + s.duration;
  const next = shots[i + 1]?.t ?? total;
  const hold = next - land;
  holds.push(hold);
  if (i > 0) {
    moving += s.duration;
  }
  console.log(
    `${String(i).padStart(2)} ${s.t.toFixed(1).padStart(7)} ${land.toFixed(1).padStart(6)} ${(i === 0 ? 0 : s.duration).toFixed(1).padStart(6)} ${hold.toFixed(1).padStart(5)} ${s.distance.toFixed(0).padStart(6)}  ${subject(layout, s.lookAt, s.distance, land, next)}`,
  );
});
const avg = holds.reduce((a, b) => a + b, 0) / holds.length;
/** Holds before another move: the last one runs to the end of the video. */
const between = holds.slice(0, -1);
console.log(
  `\n${file}: ${total.toFixed(1)} s, ${tl.chapters.length} chapters, ${tl.events.length} events`,
);
console.log(`shots ${shots.length}`);
console.log(`camera moving ${moving.toFixed(1)} s = ${((100 * moving) / total).toFixed(0)} %`);
console.log(
  `hold avg ${avg.toFixed(1)} s (shot avg ${(total / shots.length).toFixed(1)} s), min ${Math.min(...between).toFixed(1)} s (after intro: ${Math.min(...between.slice(1)).toFixed(1)} s), longest ${Math.max(...holds).toFixed(1)} s`,
);
