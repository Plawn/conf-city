// Condenses a raw dated scenario into a story: churn merged, short lives pruned, migrations
// aligned, bursts snapped, chapters picked, pacing solved to a target length (docs/replay.md).
// bun scripts/condense-scenario.ts <in.json> <out.json> [--teaser] [--target S] [--lang fr|en]
//   [--chapters N] [--min-days N] [--churn-days N] [--move-days N] [--snap-days N]
//   [--stack-days N] [--chapter-days N] [--open-days N] [--max-events N] [--top-stacks N]
//   [--keep-staging] [--cloud id,id]

import { type Scenario, ScenarioError } from "../src/domain/scenario";
import { type CondenseOptions, condenseScenario } from "../src/domain/scenarioCondense";

const NUMERIC: Record<string, keyof CondenseOptions> = {
  target: "targetSec",
  chapters: "chapters",
  "min-days": "minDays",
  "churn-days": "churnDays",
  "move-days": "moveDays",
  "snap-days": "snapDays",
  "stack-days": "stackDays",
  "chapter-days": "chapterDays",
  "max-events": "maxEvents",
  "top-stacks": "topStacks",
  "open-days": "openDays",
  "min-chapter-sec": "minChapterSec",
  "max-gap": "maxGapSec",
  "chapter-sec": "chapterSec",
};

const argv = process.argv.slice(2);
const positional: string[] = [];
const opts: Partial<CondenseOptions> = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--teaser") {
    opts.teaser = true;
  } else if (arg === "--keep-staging") {
    opts.foldStaging = false;
  } else if (arg === "--cloud") {
    opts.clouds = (argv[++i] ?? "").split(",").filter(Boolean);
  } else if (arg === "--lang") {
    const lang = argv[++i];
    if (lang !== "fr" && lang !== "en") {
      fail("--lang is fr or en");
    }
    opts.lang = lang;
  } else if (arg.startsWith("--")) {
    const key = NUMERIC[arg.slice(2)];
    const value = Number(argv[++i]);
    if (!key || !Number.isFinite(value)) {
      fail(`unknown option or bad value: ${arg}`);
    }
    Object.assign(opts, { [key]: value });
  } else {
    positional.push(arg);
  }
}
const [input, output] = positional;
if (!input || !output) {
  fail("usage: bun scripts/condense-scenario.ts <in.json> <out.json> [--teaser] [--target S] …");
}

const raw = (await Bun.file(input).json()) as Scenario;
let result: ReturnType<typeof condenseScenario>;
try {
  result = condenseScenario(raw, opts);
} catch (e) {
  fail(e instanceof ScenarioError ? e.message : String(e));
}
const { scenario, report: r } = result;
await Bun.write(output, `${JSON.stringify(scenario, null, 2)}\n`);

console.log(`✓ ${input} → ${output}${opts.teaser ? " (teaser)" : ""}`);
console.log(
  `  events   ${r.eventsBefore} → ${r.eventsAfter} (cities + services: ${r.beatsBefore} → ${r.beatsAfter})`,
);
console.log(`  clouds   ${r.clouds.join(", ") || "none"}`);
console.log(`  services ${r.nodesBefore} → ${r.nodesAfter}`);
console.log(`  churn merged ${r.churnMerged.length}`);
for (const m of r.churnMerged) {
  console.log(`    ${m.address} ← ${m.absorbed.join(", ")}`);
}
console.log(`  staging folded ${r.stagingFolded.reduce((s, m) => s + m.absorbed.length, 0)}`);
console.log(`  pruned ${r.pruned.length}${r.pruned.length ? `: ${r.pruned.join(", ")}` : ""}`);
if (r.droppedCities.length > 0) {
  console.log(`  cities dropped: ${r.droppedCities.join(", ")}`);
}
if (r.emptyLinks > 0) {
  console.log(`  empty links dropped ${r.emptyLinks}`);
}
if (r.cut.length > 0) {
  console.log(`  cut ${r.cut.length} services to hold the event cap: ${r.cut.join(", ")}`);
}
console.log(`  moves ${r.moves.reduce((s, g) => s + g.nodes.length, 0)}`);
for (const g of r.moves) {
  console.log(`    ${g.at}  ${g.fromCity} → ${g.toCity}  ${g.nodes.length}: ${g.nodes.join(", ")}`);
}
console.log(`  chapters ${r.chapters.length}`);
for (const [i, ch] of r.chapters.entries()) {
  const extra = [ch.stat, ch.caption].filter(Boolean).join(" · ");
  const len = r.chapterSec[i]?.toFixed(1) ?? "?";
  console.log(`    ${ch.at}  ${len.padStart(5)} s  ${ch.title}${extra ? `  — ${extra}` : ""}`);
}
console.log(
  `  durationSec ${r.durationSec}, maxGapSec ${r.maxGapSec}, total ${r.totalSec.toFixed(1)} s`,
);
for (const w of r.warnings) {
  console.log(`  ⚠ ${w}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
