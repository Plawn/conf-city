import type { Scenario, ScenarioChapter, ScenarioCity, ScenarioNode } from "./scenario";
import {
  type CondenseOptions,
  cloudLike,
  DAY,
  DEFAULT_CONDENSE,
  groupMoves,
  isoDate,
  type Life,
  lifeOf,
  type Move,
  nodeLife,
  stackOf,
} from "./scenarioCondenseCore";

/** Rule 5 of the condenser (`scenarioCondense.ts`): chapter candidates, scores and titles. */

export interface ChapterInfo {
  score: number;
  count: number;
  /** Set on an island or cloud arrival. */
  island?: string;
}

interface Candidate {
  date: number;
  kind: "start" | "city" | "move" | "cloud" | "burst";
  score: number;
  count: number;
  cityId?: string;
  fromCity?: string;
  /** Addresses that arrive (or move) with it, for the caption. */
  nodes: string[];
  absorbed: Candidate[];
}

export const TEXT = {
  fr: {
    start: "Le point de départ",
    islands: (n: number, m: number) =>
      `${n} service${n > 1 ? "s" : ""} sur ${m} île${m > 1 ? "s" : ""}`,
    city: (name: string) => `${name} arrive`,
    cloud: (name: string) => `${name} dans le nuage`,
    move: (name: string) => `Déménagement vers ${name}`,
    from: (name: string) => `Depuis ${name} : `,
    plus: (n: number) => `+${n} service${n > 1 ? "s" : ""}`,
    moved: (n: number) => `${n} service${n > 1 ? "s" : ""} déménagé${n > 1 ? "s" : ""}`,
    and: " et ",
    after: (a: string, b: string) => `${a}, puis ${b}`,
  },
  en: {
    start: "The starting point",
    islands: (n: number, m: number) =>
      `${n} service${n > 1 ? "s" : ""} on ${m} island${m > 1 ? "s" : ""}`,
    city: (name: string) => `${name} joins`,
    cloud: (name: string) => `${name} in the cloud`,
    move: (name: string) => `Moving to ${name}`,
    from: (name: string) => `From ${name}: `,
    plus: (n: number) => `+${n} service${n > 1 ? "s" : ""}`,
    moved: (n: number) => `${n} service${n > 1 ? "s" : ""} moved`,
    and: " and ",
    after: (a: string, b: string) => `${a}, then ${b}`,
  },
} as const;

const SCORE = { start: 10_000, city: 3000, move: 2000, cloud: 1000, burst: 0 } as const;
export const MIN_MOVED = 5;
const TITLE_MAX = 32;

/** Rule 5: the story's beats, scored, spaced `chapterDays` apart, titled in `lang`. */
export function planChapters(
  scn: Scenario,
  moves: readonly Move[],
  opts: Pick<
    CondenseOptions,
    "chapters" | "maxChapters" | "chapterDays" | "lang"
  > = DEFAULT_CONDENSE,
  clouds: ReadonlySet<string> = cloudLike(scn),
  /** Filled with each chapter's score and island, by date, for the pacing step. */
  info?: Map<string, ChapterInfo>,
): ScenarioChapter[] {
  const text = TEXT[opts.lang];
  const start = Date.parse(scn.start);
  const nodeAt = new Map<string, { c: ScenarioCity; n: ScenarioNode; life: Life }>();
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      nodeAt.set(`${c.id}/${n.id}`, { c, n, life: nodeLife(c, n) });
    }
  }
  const arrivalsOn = new Map<number, string[]>();
  for (const [address, { life }] of nodeAt) {
    if (Number.isFinite(life.since)) {
      arrivalsOn.set(life.since, [...(arrivalsOn.get(life.since) ?? []), address]);
    }
  }
  const candidates: Candidate[] = [];
  const add = (c: Omit<Candidate, "score" | "absorbed">) =>
    candidates.push({ ...c, score: SCORE[c.kind] + c.count, absorbed: [] });
  const initial = [...nodeAt.values()].filter((x) => !Number.isFinite(x.life.since));
  if (initial.length > 0) {
    add({ date: start, kind: "start", count: initial.length, nodes: [] });
  }
  for (const c of scn.cities) {
    const since = lifeOf(c).since;
    if (Number.isFinite(since)) {
      const nodes = (arrivalsOn.get(since) ?? []).filter((a) => a.startsWith(`${c.id}/`));
      add({
        date: since,
        kind: clouds.has(c.id) ? "cloud" : "city",
        count: nodes.length,
        cityId: c.id,
        nodes,
      });
    }
  }
  for (const g of groupMoves(moves)) {
    if (g.nodes.length >= MIN_MOVED) {
      add({
        date: Date.parse(g.at),
        kind: "move",
        count: g.nodes.length,
        cityId: g.toCity,
        fromCity: g.fromCity,
        nodes: g.nodes.map((id) => `${g.toCity}/${id}`),
      });
    }
  }
  for (const [date, nodes] of arrivalsOn) {
    if (nodes.length >= 2) {
      add({ date, kind: "burst", count: nodes.length, nodes });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.date - b.date);
  const target = Math.min(opts.chapters, opts.maxChapters);
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    const near = accepted
      .filter((a) => Math.abs(a.date - c.date) < opts.chapterDays * DAY)
      .sort((a, b) => Math.abs(a.date - c.date) - Math.abs(b.date - c.date))[0];
    if (near) {
      near.absorbed.push(c);
    } else if (accepted.length < target) {
      accepted.push(c);
    }
  }
  const cityName = (id: string | undefined) =>
    scn.cities.find((c) => c.id === id)?.name ?? id ?? "";
  const labelsOf = (addresses: string[]) =>
    captionLabels(
      addresses.map((a) => nodeAt.get(a)?.n).filter((n) => n !== undefined),
      text.and,
    );
  const unique = (list: Candidate[]) => new Set(list.flatMap((x) => x.nodes)).size;
  return accepted
    .sort((a, b) => a.date - b.date)
    .map((c): ScenarioChapter => {
      const at = isoDate(c.date);
      info?.set(at, { score: c.score, count: c.count });
      if (c.kind === "start") {
        const cities = new Set(initial.map((x) => x.c.id)).size;
        return { at, title: text.start, caption: text.islands(c.count, cities) };
      }
      const moved = [c, ...c.absorbed].find((x) => x.kind === "move" && x.cityId === c.cityId);
      if (c.kind === "move") {
        return {
          at,
          title: clip(text.move(cityName(c.cityId))),
          caption: text.from(cityName(c.fromCity)) + labelsOf(c.nodes),
          stat: text.moved(unique([c, ...c.absorbed.filter((a) => a.kind === "move")])),
        };
      }
      const caption =
        moved && moved !== c
          ? text.from(cityName(moved.fromCity)) + labelsOf(moved.nodes)
          : labelsOf(c.nodes);
      const count = Math.max(1, unique([c, ...c.absorbed]));
      const stat = text.plus(count);
      info?.set(at, {
        score: c.score,
        count,
        ...(c.kind === "city" || c.kind === "cloud" ? { island: cityName(c.cityId) } : {}),
      });
      if (c.kind === "city" || c.kind === "cloud") {
        const name = cityName(c.cityId);
        return {
          at,
          title: clip(c.kind === "city" ? text.city(name) : text.cloud(name)),
          caption,
          stat,
        };
      }
      return { at, title: burstTitle(c.nodes.map((a) => nodeAt.get(a)!.n)), caption, stat };
    });
}

export const clip = (s: string) => (s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX - 1)}…`);

const display = (n: ScenarioNode) => (n.label ?? n.id).replace(/\s*\([^)]*\)/g, "").trim();

/** Up to 3 labels, one per stack (largest first), production before staging. */
function captionLabels(nodes: ScenarioNode[], and: string): string {
  const byStack = new Map<string, ScenarioNode[]>();
  for (const n of nodes) {
    const s = n.group ?? stackOf(n);
    byStack.set(s, [...(byStack.get(s) ?? []), n]);
  }
  const rank = (n: ScenarioNode) =>
    (/staging/i.test(n.label ?? n.id) ? 2 : 0) + (n.ingress || n.type === "db" ? 0 : 1);
  const picks: string[] = [];
  for (const [, group] of [...byStack].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    const best = [...group].sort(
      (a, b) => rank(a) - rank(b) || display(a).localeCompare(display(b)),
    )[0]!;
    const label = display(best);
    if (!picks.includes(label)) {
      picks.push(label);
    }
    if (picks.length === 3) {
      break;
    }
  }
  return picks.length <= 1
    ? (picks[0] ?? "")
    : `${picks.slice(0, -1).join(", ")}${and}${picks.at(-1)}`;
}

/** The biggest stacks of a burst, by name, as long as they fit. */
function burstTitle(nodes: ScenarioNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const s = n.group ?? stackOf(n);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const names = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s]) => s.charAt(0).toUpperCase() + s.slice(1));
  let title = names[0] ?? "";
  for (const name of names.slice(1, 2)) {
    if (title.length + 2 + name.length <= TITLE_MAX) {
      title = `${title}, ${name}`;
    }
  }
  return clip(title);
}
