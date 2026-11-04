// Validates a replay scenario and prints its timeline, as the video will play it.
// bun scripts/check-scenario.ts public/scenarios/2026.json
import { BIOME_IDS } from "../src/domain/biome";
import {
  dateAt,
  type Lifetime,
  NODE_TYPES,
  parseScenario,
  type Scenario,
  ScenarioError,
} from "../src/domain/scenario";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/check-scenario.ts <scenario.json>");
  process.exit(2);
}

let json: Scenario;
try {
  json = await Bun.file(path).json();
} catch (e) {
  console.error(`✗ ${path}: not valid JSON — ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

let tl: ReturnType<typeof parseScenario>;
try {
  tl = parseScenario(json);
} catch (e) {
  console.error(`✗ ${path}\n${e instanceof ScenarioError ? e.message : String(e)}`);
  process.exit(1);
}

// Problems parseScenario tolerates but that make a poor video.
const warnings: string[] = [];
const start = Date.parse(json.start);
const end = Date.parse(json.end);
const checkLife = (life: Lifetime, where: string) => {
  const since = life.since ? Date.parse(life.since) : start;
  const until = life.until ? Date.parse(life.until) : end;
  if (since < start || since > end) {
    warnings.push(`${where}: since ${life.since} is outside ${json.start} → ${json.end}`);
  }
  if (life.until && (until < start || until > end)) {
    warnings.push(`${where}: until ${life.until} is outside ${json.start} → ${json.end}`);
  }
  if (life.since && life.until && until <= since) {
    warnings.push(`${where}: until is not after since — it never appears`);
  }
};
for (const c of json.cities) {
  checkLife(c, c.id);
  const biome = c.biome ?? c.meta?.biome;
  if (biome && !(BIOME_IDS as readonly string[]).includes(biome)) {
    warnings.push(`${c.id}: unknown biome "${biome}" (${BIOME_IDS.join(", ")})`);
  }
  if (c.cloud && c.meta?.memMb) {
    warnings.push(`${c.id}: meta.memMb is ignored on a cloud — its deck fits its buildings`);
  } else if (!c.cloud && !c.meta?.memMb) {
    warnings.push(`${c.id}: no meta.memMb — the island gets a default size`);
  }
  for (const n of c.nodes ?? []) {
    const addr = `${c.id}/${n.id}`;
    checkLife(n, addr);
    if (!NODE_TYPES.has(n.type)) {
      warnings.push(`${addr}: type "${n.type}" is not one of ${[...NODE_TYPES].join(", ")}`);
    }
    if (c.since && n.since && Date.parse(n.since) < Date.parse(c.since)) {
      warnings.push(`${addr}: since ${n.since} is before its city's (${c.since}) — clipped`);
    }
    for (const l of n.links ?? []) {
      if (typeof l !== "string") {
        checkLife(l, `${addr}->${l.to}`);
      }
    }
  }
}
for (const l of json.links ?? []) {
  checkLife(l, `${l.from}->${l.to}`);
}

const fmt = (s: number) => `${s.toFixed(1).padStart(5)} s`;
const dateOf = (s: number) => dateAt(tl, s).toISOString().slice(0, 10);
console.log(`✓ ${json.title} — ${tl.totalSec.toFixed(1)} s of video, ${tl.events.length} events`);
const monthSec = (json.durationSec / ((end - start) / 86_400_000)) * 30.4;
const slowSec = tl.clock.sec[tl.clock.sec.length - 1]! - tl.clock.sec[0]! - json.durationSec;
console.log(
  `  ${monthSec.toFixed(1)} s per month at base pace, +${slowSec.toFixed(1)} s of slow motion; ` +
    `a building rises in ${tl.rampSec} s\n`,
);
let previous = -Infinity;
for (const e of tl.events) {
  const crowded = e.at - previous < 0.5 ? "  ← same instant as the line above" : "";
  console.log(
    `${fmt(e.at)}  ${dateOf(e.at)}  ${e.kind === "add" ? "+" : "×"} ${e.what.padEnd(4)} ${e.id}${crowded}`,
  );
  previous = e.at;
}
if (warnings.length > 0) {
  console.log(`\n⚠ ${warnings.length} warning(s)`);
  for (const w of warnings) {
    console.log(`  - ${w}`);
  }
}
