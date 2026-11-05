import { dateAt, type Timeline, type TimelineChapter, type TimelineEvent } from "./scenario";

/** Replay narration as pure functions of video time: chapter cards, progress, recap figures. */

export const CARD_FADE_IN = 0.35;
export const CARD_FADE_OUT = 0.5;
export const RECAP_FADE = 0.6;
export const RECAP_COUNT_SEC = 1.2;
export const RECAP_STAGGER = 0.15;
/** The date leaps once it runs this many times faster than its mean pace. */
export const LEAP_FACTOR = 4;
const LEAP_WINDOW = 0.25;
const DAY_MS = 86_400_000;
/** A removal and an addition this close in date read as one service moving. */
const MOVE_WINDOW_MS = 31 * DAY_MS;

type Lang = "en" | "fr";
type Plural = { one: string; other: string };

const STRINGS: Record<Lang, Record<string, Plural>> = {
  en: {
    server: { one: "server", other: "servers" },
    island: { one: "island", other: "islands" },
    cloud: { one: "cloud", other: "clouds" },
    service: { one: "service", other: "services" },
    deployed: { one: "service deployed", other: "services deployed" },
    bridge: { one: "bridge", other: "bridges" },
    moved: { one: "moved", other: "moved" },
    demolished: { one: "demolished", other: "demolished" },
    demolition: { one: "demolition", other: "demolitions" },
    month: { one: "month", other: "months" },
    busiestMonth: { one: "event in the busiest month", other: "events in the busiest month" },
    biggestDay: { one: "event in a single day", other: "events in a single day" },
    longestLived: { one: "day in service", other: "days in service" },
  },
  fr: {
    server: { one: "serveur", other: "serveurs" },
    island: { one: "île", other: "îles" },
    cloud: { one: "cloud", other: "clouds" },
    service: { one: "service", other: "services" },
    deployed: { one: "service déployé", other: "services déployés" },
    bridge: { one: "pont", other: "ponts" },
    moved: { one: "déménagé", other: "déménagés" },
    demolished: { one: "démoli", other: "démolis" },
    demolition: { one: "démolition", other: "démolitions" },
    month: { one: "mois", other: "mois" },
    busiestMonth: {
      one: "événement au mois le plus chargé",
      other: "événements au mois le plus chargé",
    },
    biggestDay: { one: "événement en une journée", other: "événements en une journée" },
    longestLived: { one: "jour en service", other: "jours en service" },
  },
};

export type StringKey = keyof (typeof STRINGS)["en"];

/** UI language of the strings: French when the scenario says so, else English. */
export function langOf(tl: Timeline): Lang {
  return tl.scenario.lang?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** A localised word for `n` things. */
export function word(tl: Timeline, key: StringKey, n: number): string {
  const p = STRINGS[langOf(tl)][key]!;
  // French singular covers 0 and 1.
  const one = langOf(tl) === "fr" ? Math.abs(n) < 2 : Math.abs(n) === 1;
  return one ? p.one : p.other;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;

export interface ChapterState {
  chapter: TimelineChapter;
  /** Progress within the chapter, 0 → 1. */
  progress: number;
  /** Title card opacity, 0 → 1. */
  card: number;
  /** Card slide: 1 → 0 while it fades in, 0 → −1 while it fades out (× 12 px). */
  lift: number;
}

/** The chapter playing at `t`, null before the first and in the outro. */
export function chapterAt(tl: Timeline, t: number): ChapterState | null {
  let chapter: TimelineChapter | null = null;
  for (const ch of tl.chapters) {
    if (ch.at <= t && t < ch.to) {
      chapter = ch;
    }
  }
  if (!chapter) {
    return null;
  }
  const age = t - chapter.at;
  const fadeIn = clamp01(age / CARD_FADE_IN);
  const end = Math.min(chapter.holdSec + CARD_FADE_OUT, chapter.to - chapter.at);
  const fadeOut = clamp01((end - age) / CARD_FADE_OUT);
  const card = Math.min(fadeIn, fadeOut);
  const lift = fadeIn < 1 ? 1 - easeOut(fadeIn) : fadeOut < 1 ? -(1 - fadeOut) : 0;
  return {
    chapter,
    progress: clamp01(age / (chapter.to - chapter.at)),
    card,
    lift,
  };
}

const nodeIdOf = (addr: string) => addr.slice(addr.indexOf("/") + 1);

/** Labels by address, to match a service across cities. */
function labels(tl: Timeline): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of tl.world.cities) {
    for (const n of c.nodes) {
      out.set(`${c.id}/${n.id}`, n.label || n.id);
    }
  }
  return out;
}

/** Node removals paired with a nearby addition of the same id or label in another city. */
function moves(tl: Timeline, events: TimelineEvent[]): Map<TimelineEvent, TimelineEvent> {
  const label = labels(tl);
  const adds = events.filter((e) => e.what === "node" && e.kind === "add");
  const used = new Set<TimelineEvent>();
  const out = new Map<TimelineEvent, TimelineEvent>();
  for (const r of events) {
    if (r.what !== "node" || r.kind !== "remove") {
      continue;
    }
    let best: TimelineEvent | null = null;
    for (const a of adds) {
      const same =
        nodeIdOf(a.id) === nodeIdOf(r.id) ||
        (label.get(a.id) ?? a.id) === (label.get(r.id) ?? r.id);
      if (
        same &&
        a.cityId !== r.cityId &&
        Math.abs(dateAt(tl, a.at).getTime() - dateAt(tl, r.at).getTime()) <= MOVE_WINDOW_MS &&
        !used.has(a) &&
        (!best || Math.abs(a.at - r.at) < Math.abs(best.at - r.at))
      ) {
        best = a;
      }
    }
    if (best) {
      used.add(best);
      out.set(r, best);
    }
  }
  return out;
}

const cloudIds = (tl: Timeline) => new Set(tl.world.cities.filter((c) => c.cloud).map((c) => c.id));

/** The chapter's events: `at <= e.at < to`. */
export function chapterEvents(tl: Timeline, ch: TimelineChapter): TimelineEvent[] {
  return tl.events.filter((e) => ch.at <= e.at && e.at < ch.to);
}

/** The chapter's chip: its `stat`, else what it built ("+3 services · 1 moved"), else null. */
export function chapterStat(tl: Timeline, ch: TimelineChapter): string | null {
  if (ch.stat) {
    return ch.stat;
  }
  const events = chapterEvents(tl, ch);
  const moved = moves(tl, events);
  const movedAdds = new Set(moved.values());
  const clouds = cloudIds(tl);
  const count = (f: (e: TimelineEvent) => boolean) => events.filter(f).length;
  const islands = count((e) => e.what === "city" && e.kind === "add" && !clouds.has(e.id));
  const newClouds = count((e) => e.what === "city" && e.kind === "add" && clouds.has(e.id));
  const added = count((e) => e.what === "node" && e.kind === "add" && !movedAdds.has(e));
  const removed = count((e) => e.what === "node" && e.kind === "remove" && !moved.has(e));
  const parts: string[] = [];
  if (islands > 0) {
    parts.push(`+${islands} ${word(tl, "island", islands)}`);
  }
  if (newClouds > 0) {
    parts.push(`+${newClouds} ${word(tl, "cloud", newClouds)}`);
  }
  if (added > 0) {
    parts.push(`+${added} ${word(tl, "service", added)}`);
  }
  if (moved.size > 0) {
    parts.push(`${moved.size} ${word(tl, "moved", moved.size)}`);
  }
  if (removed > 0) {
    parts.push(`${removed} ${word(tl, "demolished", removed)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface RecapStat {
  key:
    | "islands"
    | "clouds"
    | "services"
    | "bridges"
    | "demolitions"
    | "moved"
    | "busiestMonth"
    | "biggestDay"
    | "longestLived"
    | "months";
  value: number;
  /** Caption under the figure. */
  label: string;
  /** Second line: the month, the day, the service. */
  detail?: string;
  date?: Date;
}

const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();

/** Recap figures over the whole scenario, localised (`Intl` in the scenario's `lang`). */
export function scenarioStats(tl: Timeline): RecapStat[] {
  const locale = tl.scenario.lang;
  const clouds = cloudIds(tl);
  const lived = (s: { from: number; to: number }) => s.from < s.to;
  let islands = 0;
  let cloudCount = 0;
  for (const [id, span] of tl.cities) {
    if (lived(span)) {
      if (clouds.has(id)) {
        cloudCount++;
      } else {
        islands++;
      }
    }
  }
  const services = [...tl.nodes.values()].filter(lived).length;
  let bridges = 0;
  for (const l of tl.links) {
    const span = tl.linkSpans.get(`${l.fromCityId}/${l.fromNodeId}->${l.toCityId}/${l.toNodeId}`);
    if (l.fromCityId !== l.toCityId && span && lived(span)) {
      bridges++;
    }
  }
  const moved = moves(tl, tl.events);
  const demolitions = tl.events.filter(
    (e) => e.what === "node" && e.kind === "remove" && !moved.has(e),
  ).length;

  // Islands and services arriving or leaving, by month and by day.
  const byMonth = new Map<number, number>();
  const byDay = new Map<number, number>();
  for (const e of tl.events) {
    if (e.what === "link") {
      continue;
    }
    const d = dateAt(tl, e.at);
    byMonth.set(monthIndex(d), (byMonth.get(monthIndex(d)) ?? 0) + 1);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const top = (m: Map<number, number>) => {
    let best: [number, number] | null = null;
    for (const [k, n] of [...m].sort(([a], [b]) => a - b)) {
      if (!best || n > best[1]) {
        best = [k, n];
      }
    }
    return best;
  };
  const month = top(byMonth);
  const day = top(byDay);

  const end = Date.parse(tl.scenario.end);
  const label = labels(tl);
  let oldest: { addr: string; since: number } | null = null;
  for (const [addr, span] of tl.nodes) {
    if (lived(span) && span.to === Infinity) {
      const since = dateAt(tl, span.from).getTime();
      if (!oldest || since < oldest.since) {
        oldest = { addr, since };
      }
    }
  }
  const start = new Date(Date.parse(tl.scenario.start));
  const months = monthIndex(new Date(end)) - monthIndex(start) + 1;

  const stat = (key: RecapStat["key"], value: number, w: StringKey, extra = {}): RecapStat => ({
    key,
    value,
    label: word(tl, w, value),
    ...extra,
  });
  const out: RecapStat[] = [
    stat("islands", islands, "island"),
    stat("clouds", cloudCount, "cloud"),
    stat("services", services, "deployed"),
    stat("bridges", bridges, "bridge"),
    stat("demolitions", demolitions, "demolition"),
    stat("moved", moved.size, "moved"),
  ];
  if (month) {
    const date = new Date(Math.floor(month[0] / 12), month[0] % 12, 1);
    const detail = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(date);
    out.push(stat("busiestMonth", month[1], "busiestMonth", { date, detail }));
  }
  if (day) {
    const date = new Date(day[0]);
    const detail = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(date);
    out.push(stat("biggestDay", day[1], "biggestDay", { date, detail }));
  }
  if (oldest) {
    const days = Math.round((end - oldest.since) / DAY_MS);
    out.push(stat("longestLived", days, "longestLived", { detail: label.get(oldest.addr) }));
  }
  out.push(stat("months", months, "month"));
  return out;
}

const COUNT_KEYS: RecapStat["key"][] = [
  "services",
  "islands",
  "clouds",
  "bridges",
  "moved",
  "demolitions",
];

/** Six recap figures: four non-zero counts, then the longest-lived service and the busiest month. */
export function recapFigures(stats: RecapStat[]): RecapStat[] {
  const byKey = new Map(stats.map((s) => [s.key, s]));
  const stories = (["longestLived", "busiestMonth"] as const)
    .map((k) => byKey.get(k))
    .filter((s) => s !== undefined);
  const counts = COUNT_KEYS.map((k) => byKey.get(k)).filter(
    (s): s is RecapStat => s !== undefined && s.value > 0,
  );
  const fill = ["biggestDay", "months"] as const;
  const out = [...counts.slice(0, 6 - stories.length)];
  for (const k of fill) {
    const s = byKey.get(k);
    if (out.length + stories.length < 6 && s) {
      out.push(s);
    }
  }
  return [...out, ...stories].slice(0, 6);
}

export interface RecapState {
  opacity: number;
  /** Shown value of each figure, counting up. */
  shown: number[];
}

/** The outro's recap card at `t`: null before `outroAt`. */
export function recapAt(tl: Timeline, t: number, figures: RecapStat[]): RecapState | null {
  const age = t - tl.outroAt;
  if (age < 0) {
    return null;
  }
  return {
    opacity: clamp01(age / RECAP_FADE),
    shown: figures.map((f, i) =>
      Math.round(
        f.value * easeOut(clamp01((age - RECAP_FADE / 2 - i * RECAP_STAGGER) / RECAP_COUNT_SEC)),
      ),
    ),
  };
}

export interface Progress {
  /** 0 → 1 over the whole video. */
  k: number;
  /** Each chapter's opening, 0 → 1. */
  markers: number[];
  /** Chapter playing, −1 before the first and in the outro. */
  current: number;
  /** The outro's start, 0 → 1. */
  outro: number;
}

export function progressAt(tl: Timeline, t: number): Progress {
  const total = tl.totalSec;
  return {
    k: clamp01(t / total),
    markers: tl.chapters.map((c) => c.at / total),
    current: chapterAt(tl, t)?.chapter.index ?? -1,
    outro: tl.outroAt / total,
  };
}

/** The date's mean pace over the video, ms per second (intro and outro excluded). */
function meanPace(tl: Timeline): number {
  const { ms, sec } = tl.clock;
  const span = sec[sec.length - 1]! - sec[0]!;
  return span > 0 ? (ms[ms.length - 1]! - ms[0]!) / span : 1 / tl.clock.rate;
}

/** The date is leaping: it runs well above its mean pace (a `maxGapSec` compression). */
export function timeLapseAt(tl: Timeline, t: number): boolean {
  const msPerSec = (dateAt(tl, t).getTime() - dateAt(tl, t - LEAP_WINDOW).getTime()) / LEAP_WINDOW;
  return msPerSec > LEAP_FACTOR * Math.min(meanPace(tl), 1 / tl.clock.rate);
}

/** Time-lapse cue strength, 0 → 1: the share of the last 0.5 s spent leaping (no flicker). */
export function leapAt(tl: Timeline, t: number): number {
  let n = 0;
  for (let i = 0; i < 6; i++) {
    n += timeLapseAt(tl, t - i * 0.1) ? 1 : 0;
  }
  return n / 6;
}
