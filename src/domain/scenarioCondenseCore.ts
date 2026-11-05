import type {
  Lifetime,
  Scenario,
  ScenarioChapter,
  ScenarioCity,
  ScenarioLink,
  ScenarioNode,
} from "./scenario";

/**
 * Turns a raw dated scenario (every commit a ceremony) into a story: churn merged, short-lived
 * services pruned, migrations aligned, bursts snapped, chapters picked, pacing solved to a target
 * length (`docs/replay.md`, condense). Pure and deterministic. Options, types and lifetimes here.
 */
export interface CondenseOptions {
  /** A service removed then re-added (same id or label) within this many days is one lifetime. */
  churnDays: number;
  /** A staging service folds into its production twin. */
  foldStaging: boolean;
  /** Arrivals this many days after `start` are part of the starting point. */
  openDays: number;
  /** Services alive fewer days disappear (migration ends excepted). */
  minDays: number;
  /** A service leaving city A and appearing in city B within ±this many days moved. */
  moveDays: number;
  /** Arrivals (removals) within this many days of a burst's first date snap to it. */
  snapDays: number;
  /** Same-stack arrivals within this many days snap to the stack's first one. */
  stackDays: number;
  /** Chapter count aimed at (clamped to `maxChapters`). */
  chapters: number;
  maxChapters: number;
  /** Least days between two chapters. */
  chapterDays: number;
  lang: "fr" | "en";
  /** Video seconds aimed at; `durationSec` is solved for it. */
  targetSec: number;
  /** 60 s cut: cities, clouds, migrations, ingress, db and the biggest stacks only. */
  teaser: boolean;
  /** Event cap: the smallest stacks go until it holds. */
  maxEvents: number;
  /** Stacks kept by size before the cap (the teaser keeps 6). */
  topStacks: number;
  minGapSec: number;
  staggerSec: number;
  maxGapSec: number;
  chapterSec: number;
  introSec: number;
  outroSec: number;
  /** Least video seconds a chapter lasts: the director needs room for its own camera move. */
  minChapterSec: number;
  /** Cities forced to `cloud`; undefined = those whose every service has an external look. */
  clouds?: string[];
}

export const DEFAULT_CONDENSE: CondenseOptions = {
  churnDays: 30,
  foldStaging: true,
  openDays: 14,
  minDays: 14,
  moveDays: 14,
  snapDays: 4,
  stackDays: 10,
  chapters: 9,
  maxChapters: 12,
  chapterDays: 10,
  lang: "en",
  targetSec: 100,
  teaser: false,
  maxEvents: 130,
  topStacks: Infinity,
  minGapSec: 0.8,
  staggerSec: 0.25,
  maxGapSec: 1,
  chapterSec: 1.8,
  introSec: 3,
  outroSec: 6,
  minChapterSec: 6,
};

/** Defaults, with the teaser's own target and chapter count unless given. */
export function condenseOptions(partial: Partial<CondenseOptions> = {}): CondenseOptions {
  const teaser = partial.teaser === true;
  return {
    ...DEFAULT_CONDENSE,
    ...(teaser ? { targetSec: 60, chapters: 7, maxEvents: 70, topStacks: 6 } : {}),
    ...partial,
  };
}

export interface Move {
  fromCity: string;
  fromId: string;
  toCity: string;
  toId: string;
  /** ISO date the new one rises and the old one explodes. */
  at: string;
}

export interface MoveGroup {
  fromCity: string;
  toCity: string;
  at: string;
  /** Target node ids. */
  nodes: string[];
}

export interface CondenseReport {
  /** Every event `parseScenario` plays, links included (what check-scenario counts). */
  eventsBefore: number;
  eventsAfter: number;
  /** City and service events only: what `maxEvents` caps. */
  beatsBefore: number;
  beatsAfter: number;
  /** Cities marked `cloud`. */
  clouds: string[];
  /** Video seconds each chapter lasts, title card included. */
  chapterSec: number[];
  nodesBefore: number;
  nodesAfter: number;
  /** Kept address ← the addresses folded into it. */
  churnMerged: { address: string; absorbed: string[] }[];
  /** Production address ← the staging twins folded into it. */
  stagingFolded: { address: string; absorbed: string[] }[];
  pruned: string[];
  droppedCities: string[];
  moves: MoveGroup[];
  /** Addresses cut to hold `maxEvents`. */
  cut: string[];
  /** Links dropped because their clipped life was empty. */
  emptyLinks: number;
  chapters: ScenarioChapter[];
  durationSec: number;
  /** Raised above the option when even the slowest base pace stays short of the target. */
  maxGapSec: number;
  totalSec: number;
  warnings: string[];
}

export const DAY = 86_400_000;

export interface Life {
  since: number;
  until: number;
}

export function lifeOf(l: Lifetime): Life {
  return {
    since: l.since ? Date.parse(l.since) : -Infinity,
    until: l.until ? Date.parse(l.until) : Infinity,
  };
}

export function isoDate(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

export function setLife(obj: Lifetime, life: Life): void {
  if (Number.isFinite(life.since)) {
    obj.since = isoDate(life.since);
  } else {
    delete obj.since;
  }
  if (Number.isFinite(life.until)) {
    obj.until = isoDate(life.until);
  } else {
    delete obj.until;
  }
}

/** Node lifetime clipped to its city's. */
export function nodeLife(city: ScenarioCity, n: ScenarioNode): Life {
  const c = lifeOf(city);
  const l = lifeOf(n);
  return { since: Math.max(c.since, l.since), until: Math.min(c.until, l.until) };
}

/** Label without "(compose)", "(v2)"…, lower-cased: how a renamed service is recognised. */
export function labelKey(n: Pick<ScenarioNode, "id" | "label">): string {
  return (n.label ?? n.id)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Node id prefix before the first ".", else its group, else its id. */
export function stackOf(n: Pick<ScenarioNode, "id" | "group">): string {
  const dot = n.id.indexOf(".");
  return dot > 0 ? n.id.slice(0, dot) : (n.group ?? n.id);
}

export const linkTo = (l: string | ScenarioLink) => (typeof l === "string" ? l : l.to);

export function groupMoves(moves: readonly Move[]): MoveGroup[] {
  const groups = new Map<string, MoveGroup>();
  for (const m of moves) {
    const key = `${m.fromCity}>${m.toCity}@${m.at}`;
    const g = groups.get(key) ?? { fromCity: m.fromCity, toCity: m.toCity, at: m.at, nodes: [] };
    g.nodes.push(m.toId);
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => a.at.localeCompare(b.at) || b.nodes.length - a.nodes.length,
  );
}

/** Cities flagged `cloud`. */
export function cloudLike(scn: Scenario): Set<string> {
  return new Set(scn.cities.filter((c) => c.cloud === true).map((c) => c.id));
}
