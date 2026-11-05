import {
  parseScenario,
  type Scenario,
  type ScenarioChapter,
  type ScenarioCity,
  type ScenarioLink,
  type ScenarioNode,
} from "./scenario";
import { type ChapterInfo, clip, MIN_MOVED, planChapters, TEXT } from "./scenarioCondenseChapters";
import {
  type CondenseOptions,
  type CondenseReport,
  cloudLike,
  condenseOptions,
  DAY,
  DEFAULT_CONDENSE,
  groupMoves,
  isoDate,
  type Life,
  labelKey,
  lifeOf,
  linkTo,
  type Move,
  nodeLife,
  setLife,
  stackOf,
} from "./scenarioCondenseCore";

export * from "./scenarioCondenseChapters";
export * from "./scenarioCondenseCore";

/** Points every reference to `cityId/fromId` at `toId`. */
function retarget(scn: Scenario, cityId: string, fromId: string, toId: string): void {
  const city = scn.cities.find((c) => c.id === cityId)!;
  for (const n of city.nodes) {
    n.links = n.links?.map((l) =>
      linkTo(l) !== fromId ? l : typeof l === "string" ? toId : { ...l, to: toId },
    );
  }
  const from = `${cityId}/${fromId}`;
  const to = `${cityId}/${toId}`;
  for (const l of scn.links ?? []) {
    l.from = l.from === from ? to : l.from;
    l.to = l.to === from ? to : l.to;
  }
}

const unionLife = (a: Life, b: Life): Life => ({
  since: Math.min(a.since, b.since),
  until: Math.max(a.until, b.until),
});

/** Drops self-links and folds duplicates into one link over the union of their lifetimes. */
function dedupeLinks(scn: Scenario): void {
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      if (!n.links) {
        continue;
      }
      const byTo = new Map<string, Life>();
      for (const l of n.links) {
        const to = linkTo(l);
        if (to === n.id) {
          continue;
        }
        const life = lifeOf(typeof l === "string" ? {} : l);
        const prev = byTo.get(to);
        byTo.set(to, prev ? unionLife(prev, life) : life);
      }
      n.links = [...byTo].map(([to, life]) => {
        if (!Number.isFinite(life.since) && !Number.isFinite(life.until)) {
          return to;
        }
        const link: ScenarioLink = { to };
        setLife(link, life);
        return link;
      });
    }
  }
  if (scn.links) {
    const byKey = new Map<string, { from: string; to: string; life: Life }>();
    for (const l of scn.links) {
      if (l.from === l.to) {
        continue;
      }
      const key = `${l.from}->${l.to}`;
      const prev = byKey.get(key);
      const life = lifeOf(l);
      byKey.set(key, { from: l.from, to: l.to, life: prev ? unionLife(prev.life, life) : life });
    }
    scn.links = [...byKey.values()].map(({ from, to, life }) => {
      const link: NonNullable<Scenario["links"]>[number] = { from, to };
      setLife(link, life);
      return link;
    });
  }
}

/** Removes nodes and every link touching them. */
function dropNodes(scn: Scenario, addresses: ReadonlySet<string>): void {
  for (const c of scn.cities) {
    c.nodes = c.nodes.filter((n) => !addresses.has(`${c.id}/${n.id}`));
    for (const n of c.nodes) {
      n.links = n.links?.filter((l) => !addresses.has(`${c.id}/${linkTo(l)}`));
    }
  }
  if (scn.links) {
    scn.links = scn.links.filter((l) => !addresses.has(l.from) && !addresses.has(l.to));
  }
}

/** Removes links whose life, clipped to both ends, is empty: a road that never shows. */
export function dropEmptyLinks(scn: Scenario): number {
  const lives = new Map<string, Life>();
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      lives.set(`${c.id}/${n.id}`, nodeLife(c, n));
    }
  }
  const empty = (own: Life, ends: string[]) => {
    let { since, until } = own;
    for (const e of ends) {
      const l = lives.get(e);
      if (!l) {
        return true;
      }
      since = Math.max(since, l.since);
      until = Math.min(until, l.until);
    }
    return since >= until;
  };
  let dropped = 0;
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      const before = n.links?.length ?? 0;
      n.links = n.links?.filter(
        (l) =>
          !empty(lifeOf(typeof l === "string" ? {} : l), [
            `${c.id}/${n.id}`,
            `${c.id}/${linkTo(l)}`,
          ]),
      );
      dropped += before - (n.links?.length ?? 0);
    }
  }
  if (scn.links) {
    const before = scn.links.length;
    scn.links = scn.links.filter((l) => !empty(lifeOf(l), [l.from, l.to]));
    dropped += before - scn.links.length;
  }
  return dropped;
}

type Merged = CondenseReport["churnMerged"];

/** Folds `a` into `b` (lifetime union, links, references) until `find` finds no pair. */
function mergePairs(
  input: Scenario,
  find: (city: ScenarioCity, nodes: ScenarioNode[]) => [ScenarioNode, ScenarioNode] | null,
): { scenario: Scenario; merged: Merged } {
  const scn = structuredClone(input);
  const merged = new Map<string, string[]>();
  for (const city of scn.cities) {
    for (;;) {
      const nodes = [...city.nodes].sort(
        (a, b) => lifeOf(a).since - lifeOf(b).since || a.id.localeCompare(b.id),
      );
      const pair = find(city, nodes);
      if (!pair) {
        break;
      }
      const [a, b] = pair;
      setLife(b, unionLife(lifeOf(a), lifeOf(b)));
      b.links = [...(b.links ?? []), ...(a.links ?? [])];
      city.nodes = city.nodes.filter((n) => n !== a);
      retarget(scn, city.id, a.id, b.id);
      const key = `${city.id}/${b.id}`;
      const absorbed = [`${city.id}/${a.id}`, ...popMerged(merged, `${city.id}/${a.id}`)];
      merged.set(key, [...(merged.get(key) ?? []), ...absorbed]);
    }
  }
  dedupeLinks(scn);
  return {
    scenario: scn,
    merged: [...merged].map(([address, absorbed]) => ({ address, absorbed })),
  };
}

/**
 * Rule 1: a service removed then re-added in its city (same id or label) is one lifetime; the
 * newer one keeps its name and look. One whose id reappears in another city moved instead.
 */
export function mergeChurn(
  input: Scenario,
  opts: Pick<CondenseOptions, "churnDays" | "moveDays"> = DEFAULT_CONDENSE,
): { scenario: Scenario; merged: Merged } {
  const arrivals = input.cities.flatMap((c) =>
    c.nodes.map((n) => ({ cityId: c.id, id: n.id, since: nodeLife(c, n).since })),
  );
  const movesAway = (cityId: string, n: ScenarioNode, until: number) =>
    arrivals.some(
      (x) =>
        x.cityId !== cityId && x.id === n.id && Math.abs(x.since - until) <= opts.moveDays * DAY,
    );
  return mergePairs(input, (city, nodes) => {
    for (const a of nodes) {
      const la = lifeOf(a);
      if (!Number.isFinite(la.until) || movesAway(city.id, a, la.until)) {
        continue;
      }
      for (const b of nodes) {
        const lb = lifeOf(b);
        if (
          b !== a &&
          Number.isFinite(lb.since) &&
          lb.since >= la.since &&
          lb.since - la.until <= opts.churnDays * DAY &&
          (a.id === b.id || labelKey(a) === labelKey(b))
        ) {
          return [a, b];
        }
      }
    }
    return null;
  });
}

const STAGING = /[\s._-]*\bstaging\b[\s._-]*/gi;

/** Twin key: the label key without "staging". */
const twinKey = (n: ScenarioNode) => labelKey(n).replace(STAGING, " ").replace(/\s+/g, " ").trim();

const isStaging = (n: ScenarioNode) => /staging/i.test(n.label ?? n.id) || /staging/i.test(n.id);

/** A staging service folds into its production twin in the same city (`churnDays` apart). */
export function foldStaging(
  input: Scenario,
  opts: Pick<CondenseOptions, "churnDays"> = DEFAULT_CONDENSE,
): { scenario: Scenario; merged: Merged } {
  return mergePairs(input, (_city, nodes) => {
    for (const a of nodes) {
      if (!isStaging(a)) {
        continue;
      }
      const la = lifeOf(a);
      const twin = nodes.find(
        (b) =>
          b !== a &&
          !isStaging(b) &&
          twinKey(b) === twinKey(a) &&
          Math.abs(clampInf(lifeOf(b).since) - clampInf(la.since)) <= opts.churnDays * DAY,
      );
      if (twin) {
        return [a, twin];
      }
    }
    return null;
  });
}

/** Open ends as 0 so two services there from the start compare as simultaneous. */
const clampInf = (ms: number) => (Number.isFinite(ms) ? ms : 0);

function popMerged(merged: Map<string, string[]>, key: string): string[] {
  const list = merged.get(key) ?? [];
  merged.delete(key);
  return list;
}

/** Rule 3: a service leaving one city and appearing in another within ±moveDays moved there. */
export function findMoves(
  scn: Scenario,
  opts: Pick<CondenseOptions, "moveDays"> = DEFAULT_CONDENSE,
): Move[] {
  const all = scn.cities.flatMap((c) => c.nodes.map((n) => ({ c, n, life: nodeLife(c, n) })));
  const targets = all
    .filter((t) => Number.isFinite(t.life.since))
    .sort((a, b) => a.life.since - b.life.since || addr(a).localeCompare(addr(b)));
  const used = new Set<string>();
  const moves: Move[] = [];
  for (const t of targets) {
    let best: { s: (typeof all)[number]; rank: number; delta: number } | null = null;
    for (const s of all) {
      if (s.c.id === t.c.id || used.has(addr(s)) || !Number.isFinite(s.life.until)) {
        continue;
      }
      const delta = Math.abs(s.life.until - t.life.since);
      if (delta > opts.moveDays * DAY || s.life.since >= t.life.since) {
        continue;
      }
      const rank = s.n.id === t.n.id ? 0 : labelKey(s.n) === labelKey(t.n) ? 1 : -1;
      if (rank < 0) {
        continue;
      }
      if (
        !best ||
        rank < best.rank ||
        (rank === best.rank && delta < best.delta) ||
        (rank === best.rank && delta === best.delta && addr(s) < addr(best.s))
      ) {
        best = { s, rank, delta };
      }
    }
    if (best) {
      used.add(addr(best.s));
      moves.push({
        fromCity: best.s.c.id,
        fromId: best.s.n.id,
        toCity: t.c.id,
        toId: t.n.id,
        at: isoDate(t.life.since),
      });
    }
  }
  return moves;
}

const addr = (x: { c: ScenarioCity; n: ScenarioNode }) => `${x.c.id}/${x.n.id}`;

/** The old one's `until` set to the new one's arrival: one cascade, rise then blast. */
export function alignMoves(scn: Scenario, moves: readonly Move[]): Move[] {
  const out: Move[] = [];
  for (const m of moves) {
    const fromCity = scn.cities.find((c) => c.id === m.fromCity);
    const toCity = scn.cities.find((c) => c.id === m.toCity);
    const s = fromCity?.nodes.find((n) => n.id === m.fromId);
    const t = toCity?.nodes.find((n) => n.id === m.toId);
    if (!fromCity || !toCity || !s || !t) {
      continue;
    }
    const at = nodeLife(toCity, t).since;
    if (nodeLife(fromCity, s).since < at) {
      setLife(s, { since: lifeOf(s).since, until: at });
      out.push({ ...m, at: isoDate(at) });
    }
  }
  return out;
}

const moveEnds = (moves: readonly Move[]) =>
  new Set(moves.flatMap((m) => [`${m.fromCity}/${m.fromId}`, `${m.toCity}/${m.toId}`]));

/** Rule 2: services alive under `minDays` go, then cities left empty. */
export function pruneShort(
  input: Scenario,
  opts: Pick<CondenseOptions, "minDays"> = DEFAULT_CONDENSE,
  keep: ReadonlySet<string> = new Set(),
): { scenario: Scenario; pruned: string[]; droppedCities: string[] } {
  const scn = structuredClone(input);
  const start = Date.parse(scn.start);
  const end = Date.parse(scn.end);
  const pruned = new Set<string>();
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      const life = nodeLife(c, n);
      const days = (Math.min(life.until, end) - Math.max(life.since, start)) / DAY;
      const address = `${c.id}/${n.id}`;
      if (days < opts.minDays && !keep.has(address)) {
        pruned.add(address);
      }
    }
  }
  dropNodes(scn, pruned);
  const droppedCities = dropEmptyCities(scn);
  return { scenario: scn, pruned: [...pruned].sort(), droppedCities };
}

function dropEmptyCities(scn: Scenario): string[] {
  const dropped = scn.cities.filter((c) => c.nodes.length === 0).map((c) => c.id);
  scn.cities = scn.cities.filter((c) => c.nodes.length > 0);
  if (scn.links) {
    scn.links = scn.links.filter(
      (l) => !dropped.some((id) => l.from.startsWith(`${id}/`) || l.to.startsWith(`${id}/`)),
    );
  }
  return dropped;
}

/** Each date snaps to the earliest anchor within `days` before it. */
function snapDates(dates: number[], days: number): Map<number, number> {
  const out = new Map<number, number>();
  let anchor = -Infinity;
  for (const d of [...new Set(dates)].sort((a, b) => a - b)) {
    if (d - anchor > days * DAY) {
      anchor = d;
    }
    out.set(d, anchor);
  }
  return out;
}

/**
 * Rule 4: per city, arrivals of a stack snap to its first one within `stackDays`, then
 * arrivals and removals within `snapDays` of a burst's first date snap to it. Migration
 * sources keep following their targets; links with their own dates follow their ends.
 */
export function snapBursts(
  input: Scenario,
  opts: Pick<CondenseOptions, "snapDays" | "stackDays" | "openDays"> = DEFAULT_CONDENSE,
  moves: readonly Move[] = [],
): { scenario: Scenario; moves: Move[] } {
  const scn = structuredClone(input);
  const pinned = new Set(moves.map((m) => `${m.fromCity}/${m.fromId}`));
  const before = new Map<string, Life>();
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      before.set(`${c.id}/${n.id}`, nodeLife(c, n));
    }
    const city = lifeOf(c);
    const arriving = c.nodes.filter((n) => Number.isFinite(lifeOf(n).since));
    const stacks = new Map<string, ScenarioNode[]>();
    for (const n of arriving) {
      const s = stackOf(n);
      stacks.set(s, [...(stacks.get(s) ?? []), n]);
    }
    for (const group of stacks.values()) {
      const snap = snapDates(
        group.map((n) => lifeOf(n).since),
        opts.stackDays,
      );
      for (const n of group) {
        const l = lifeOf(n);
        setLife(n, { since: snap.get(l.since)!, until: l.until });
      }
    }
    const arrivals = arriving.map((n) => lifeOf(n).since);
    const burst = snapDates(
      Number.isFinite(city.since) ? [city.since, ...arrivals] : arrivals,
      opts.snapDays,
    );
    for (const n of arriving) {
      const l = lifeOf(n);
      setLife(n, { since: Math.max(burst.get(l.since)!, city.since), until: l.until });
    }
    const leaving = c.nodes.filter(
      (n) => Number.isFinite(lifeOf(n).until) && !pinned.has(`${c.id}/${n.id}`),
    );
    const removal = snapDates(
      leaving.map((n) => lifeOf(n).until),
      opts.snapDays,
    );
    for (const n of leaving) {
      const l = lifeOf(n);
      const until = removal.get(l.until)!;
      if (until > l.since) {
        setLife(n, { since: l.since, until });
      }
    }
  }
  // The first days build the starting point.
  const start = Date.parse(scn.start);
  const all = scn.cities.flatMap((c) => c.nodes.map((n) => ({ c, n })));
  for (const { c, n } of all) {
    const l = lifeOf(n);
    if (!Number.isFinite(lifeOf(c).since) && l.since - start <= opts.openDays * DAY) {
      setLife(n, { since: -Infinity, until: l.until });
    }
  }
  // Then bursts snap across islands too.
  const arrivingCities = scn.cities.filter((c) => Number.isFinite(lifeOf(c).since));
  const arriving = all.filter(({ n }) => Number.isFinite(lifeOf(n).since));
  const global = snapDates(
    [...arrivingCities, ...arriving.map(({ n }) => n)].map((x) => lifeOf(x).since),
    opts.snapDays,
  );
  // Islands keep their own date: a burst snaps onto the latest island arrival it spans.
  const islandDates = arrivingCities.map((c) => lifeOf(c).since);
  for (const { c, n } of arriving) {
    const l = lifeOf(n);
    const snapped = global.get(l.since)!;
    const anchor = Math.max(snapped, ...islandDates.filter((d) => d >= snapped && d <= l.since));
    setLife(n, { since: Math.max(anchor, lifeOf(c).since), until: l.until });
  }
  const leaving = all.filter(
    ({ c, n }) => Number.isFinite(lifeOf(n).until) && !pinned.has(`${c.id}/${n.id}`),
  );
  const removal = snapDates(
    leaving.map(({ n }) => lifeOf(n).until),
    opts.snapDays,
  );
  for (const { n } of leaving) {
    const l = lifeOf(n);
    const until = removal.get(l.until)!;
    if (until > l.since) {
      setLife(n, { since: l.since, until });
    }
  }
  const aligned = alignMoves(scn, moves);
  // A link dated like one of its ends keeps following that end.
  const after = new Map<string, Life>();
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      after.set(`${c.id}/${n.id}`, nodeLife(c, n));
    }
  }
  const follow = (life: Life, ends: string[]): Life => {
    let { since, until } = life;
    for (const e of ends) {
      const [b, a] = [before.get(e), after.get(e)];
      if (b && a && b.since === life.since) {
        since = a.since;
      }
      if (b && a && b.until === life.until) {
        until = a.until;
      }
    }
    return { since, until };
  };
  for (const c of scn.cities) {
    for (const n of c.nodes) {
      for (const l of n.links ?? []) {
        if (typeof l !== "string") {
          setLife(l, follow(lifeOf(l), [`${c.id}/${n.id}`, `${c.id}/${l.to}`]));
        }
      }
    }
  }
  for (const l of scn.links ?? []) {
    setLife(l, follow(lifeOf(l), [l.from, l.to]));
  }
  return { scenario: scn, moves: aligned };
}

/** Video events `parseScenario` would play. */
export function countEvents(scn: Scenario): number {
  return parseScenario(scn).events.length;
}

/** Buildings that draw an external managed service. */
export const CLOUD_LOOKS: ReadonlySet<string> = new Set(["relay-station", "offshore-vault"]);

const lookOf = (n: ScenarioNode) => (n as { building?: unknown }).building;

/**
 * Rule 0: `ids` (default: cities whose every service has a CLOUD_LOOKS building) become
 * `cloud`, without `meta.memMb` (a cloud island has a fixed size).
 */
export function markClouds(
  input: Scenario,
  ids?: readonly string[],
): { scenario: Scenario; clouds: string[] } {
  const scn = structuredClone(input);
  const auto = (c: ScenarioCity) =>
    c.nodes.length > 0 && c.nodes.every((n) => CLOUD_LOOKS.has(String(lookOf(n))));
  const marked: string[] = [];
  for (const c of scn.cities) {
    if (c.cloud === true || (ids ? ids.includes(c.id) : auto(c))) {
      c.cloud = true;
      delete c.meta?.memMb;
      marked.push(c.id);
    }
  }
  return { scenario: scn, clouds: marked };
}

/** Events the director frames: cities and services (links ride with their ends). */
export function countBeats(scn: Scenario): number {
  return parseScenario(scn).events.filter((e) => e.what !== "link").length;
}

/**
 * Rule 7 (and the full cut's cap): keeps cities and clouds, migrations, ingress and db
 * services, services there all along and the `topStacks` biggest stacks; the smallest stacks
 * (costliest first) go until `maxEvents` holds.
 */
export function capEvents(
  input: Scenario,
  opts: Pick<CondenseOptions, "topStacks" | "maxEvents" | "teaser"> = DEFAULT_CONDENSE,
  moves: readonly Move[] = [],
  clouds: ReadonlySet<string> = cloudLike(input),
): { scenario: Scenario; cut: string[]; warnings: string[] } {
  // The teaser keeps only the migrations a chapter can tell (groups of MIN_MOVED or more).
  const big = new Set(
    groupMoves(moves)
      .filter((g) => g.nodes.length >= MIN_MOVED)
      .map((g) => `${g.at}|${g.fromCity}|${g.toCity}`),
  );
  const ends = moveEnds(
    opts.teaser ? moves.filter((m) => big.has(`${m.at}|${m.fromCity}|${m.toCity}`)) : moves,
  );
  // Services arriving with an island (any island) are part of that beat; not in the teaser.
  const beats = new Set(
    opts.teaser ? [] : input.cities.map((c) => lifeOf(c).since).filter((d) => Number.isFinite(d)),
  );
  const kept = new Set<string>();
  const stacks = new Map<string, { addresses: string[]; cost: number; legacy: boolean }>();
  for (const c of input.cities) {
    const city = lifeOf(c);
    for (const n of c.nodes) {
      const address = `${c.id}/${n.id}`;
      const life = nodeLife(c, n);
      const ticks = Number(Number.isFinite(life.since)) + Number(Number.isFinite(life.until));
      if (
        (ticks === 0 && !opts.teaser) ||
        clouds.has(c.id) ||
        (Number.isFinite(city.since) && life.since === city.since) ||
        beats.has(life.since) ||
        ends.has(address) ||
        n.ingress ||
        n.type === "db"
      ) {
        kept.add(address);
      } else {
        const key = `${c.id}/${stackOf(n)}`;
        const st = stacks.get(key) ?? { addresses: [], cost: 0, legacy: true };
        st.addresses.push(address);
        st.cost += ticks * (1 + (n.links?.length ?? 0));
        st.legacy &&= !Number.isFinite(life.since);
        stacks.set(key, st);
      }
    }
  }
  // Each cloud keeps one cable car: the island end of a link, protected if none already is.
  const lives = new Map<string, Life>(
    input.cities.flatMap((c) => c.nodes.map((n) => [`${c.id}/${n.id}`, nodeLife(c, n)] as const)),
  );
  const span = (a: string) => {
    const l = lives.get(a);
    return l ? Math.min(l.until, 1e15) - Math.max(l.since, -1e15) : -Infinity;
  };
  for (const cloud of clouds) {
    const inCloud = (a: string) => a.startsWith(`${cloud}/`);
    const islandEnds = (input.links ?? [])
      .filter((l) => inCloud(l.from) !== inCloud(l.to))
      .map((l) => (inCloud(l.from) ? l.to : l.from))
      .filter((a) => lives.has(a) && !clouds.has(a.slice(0, a.indexOf("/"))));
    if (islandEnds.length === 0 || islandEnds.some((a) => kept.has(a))) {
      continue;
    }
    const anchor = [...islandEnds].sort((x, y) => span(y) - span(x) || x.localeCompare(y))[0]!;
    kept.add(anchor);
    for (const st of stacks.values()) {
      st.addresses = st.addresses.filter((a) => a !== anchor);
    }
  }
  for (const [key, st] of stacks) {
    if (st.addresses.length === 0) {
      stacks.delete(key);
    }
  }
  // Legacy stacks (there from the start, only torn down) go first, then the smallest.
  const ranked = [...stacks].sort(
    (a, b) =>
      Number(a[1].legacy) - Number(b[1].legacy) ||
      b[1].addresses.length - a[1].addresses.length ||
      a[1].cost - b[1].cost ||
      a[0].localeCompare(b[0]),
  );
  const top = ranked.slice(0, opts.topStacks);
  const cutWith = (list: typeof ranked) => {
    const keep = new Set([...kept, ...list.flatMap(([, st]) => st.addresses)]);
    const drop = new Set<string>();
    for (const c of input.cities) {
      for (const n of c.nodes) {
        if (!keep.has(`${c.id}/${n.id}`)) {
          drop.add(`${c.id}/${n.id}`);
        }
      }
    }
    const scn = structuredClone(input);
    dropNodes(scn, drop);
    dropEmptyCities(scn);
    return { scenario: scn, cut: [...drop].sort() };
  };
  let result = cutWith(top);
  while (countBeats(result.scenario) > opts.maxEvents && top.length > 0) {
    top.pop();
    result = cutWith(top);
  }
  const warnings: string[] = [];
  const events = countBeats(result.scenario);
  if (events > opts.maxEvents) {
    warnings.push(
      `${events} city/service events kept (> ${opts.maxEvents}): the protected set alone is bigger`,
    );
  }
  return { ...result, warnings };
}

/** Rule 6: pacing fields set, `durationSec` bisected so the video lasts about `targetSec`. */
export function fitPacing(
  input: Scenario,
  opts: Pick<
    CondenseOptions,
    "targetSec" | "minGapSec" | "staggerSec" | "maxGapSec" | "chapterSec" | "introSec" | "outroSec"
  > = DEFAULT_CONDENSE,
): { scenario: Scenario; totalSec: number } {
  const base: Scenario = {
    ...input,
    minGapSec: opts.minGapSec,
    staggerSec: opts.staggerSec,
    maxGapSec: opts.maxGapSec,
    chapterSec: opts.chapterSec,
    introSec: opts.introSec,
    outroSec: opts.outroSec,
  };
  const total = (d: number, maxGapSec = opts.maxGapSec) =>
    parseScenario({ ...base, durationSec: d, maxGapSec }).totalSec;
  const solve = (f: (x: number) => number, lo: number, hi: number) => {
    if (f(lo) >= opts.targetSec) {
      return lo;
    }
    if (f(hi) <= opts.targetSec) {
      return hi;
    }
    for (let i = 0; i < 50 && hi - lo > 0.01; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) < opts.targetSec) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  };
  const MAX_DURATION = 2000;
  if (total(MAX_DURATION) >= opts.targetSec - 2) {
    const d = Math.round(solve((x) => total(x), 1, MAX_DURATION) * 10) / 10;
    return { scenario: { ...base, durationSec: d }, totalSec: total(d) };
  }
  // The time-lapse cap saturates the pace: lengthen the quiet stretches instead.
  const gap = Math.round(solve((g) => total(MAX_DURATION, g), opts.maxGapSec, 30) * 100) / 100;
  return {
    scenario: { ...base, durationSec: MAX_DURATION, maxGapSec: gap },
    totalSec: total(MAX_DURATION, gap),
  };
}

/** Time-lapse caps tried, from a uniform beat to a pace closer to the calendar. */
const GAP_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
/** Title-card lengthening tried (seconds added to `chapterSec`) when chapters run short. */
const HOLD_STEPS = [0, 0.4, 0.8];

/**
 * Rule 6 with chapters: among the `chapterSec` × `maxGapSec` steps (from the options up) that
 * land on target, the first whose chapters all last `minChapterSec`, else the longest shortest.
 */
export function paceChapters(
  scn: Scenario,
  opts: Parameters<typeof fitPacing>[1] & Pick<CondenseOptions, "minChapterSec"> = DEFAULT_CONDENSE,
): ReturnType<typeof fitPacing> {
  let best: { paced: ReturnType<typeof fitPacing>; shortest: number } | null = null;
  const tries = HOLD_STEPS.flatMap((extra) =>
    [opts.maxGapSec, ...GAP_STEPS.filter((g) => g > opts.maxGapSec)].map((gap) => ({
      gap,
      hold: opts.chapterSec + extra,
    })),
  );
  for (const { gap, hold } of tries) {
    const paced = fitPacing(scn, { ...opts, maxGapSec: gap, chapterSec: hold });
    if (best && Math.abs(paced.totalSec - opts.targetSec) > 2) {
      continue;
    }
    const lengths = parseScenario(paced.scenario).chapters.map((ch) => ch.to - ch.at);
    const shortest = Math.min(Infinity, ...lengths);
    if (!best || shortest > best.shortest + 0.05) {
      best = { paced, shortest };
    }
    if (shortest >= opts.minChapterSec) {
      break;
    }
  }
  return best!.paced;
}

const nodeCount = (scn: Scenario) => scn.cities.reduce((s, c) => s + c.nodes.length, 0);

/** Every rule in order: churn, staging, migrations, prune, snap, cap, chapters, pacing. */
export function condenseScenario(
  input: Scenario,
  partial: Partial<CondenseOptions> = {},
): { scenario: Scenario; report: CondenseReport } {
  const opts = condenseOptions(partial);
  parseScenario(input);
  const warnings: string[] = [];
  const marked = markClouds(input, opts.clouds);
  const clouds = new Set(marked.clouds);
  const churn = mergeChurn(marked.scenario, opts);
  let scn = churn.scenario;
  const staging = opts.foldStaging ? foldStaging(scn, opts) : { scenario: scn, merged: [] };
  scn = staging.scenario;
  let moves = alignMoves(scn, findMoves(scn, opts));
  const pruned = pruneShort(scn, opts, moveEnds(moves));
  scn = pruned.scenario;
  const snapped = snapBursts(scn, opts, moves);
  scn = snapped.scenario;
  moves = snapped.moves;
  const emptyLinks = dropEmptyLinks(scn);
  const capped = capEvents(scn, opts, moves, clouds);
  scn = capped.scenario;
  warnings.push(...capped.warnings);
  const left = new Set(scn.cities.flatMap((c) => c.nodes.map((n) => `${c.id}/${n.id}`)));
  moves = moves.filter(
    (m) => left.has(`${m.toCity}/${m.toId}`) && left.has(`${m.fromCity}/${m.fromId}`),
  );
  const info = new Map<string, ChapterInfo>();
  let chapters = planChapters(scn, moves, opts, clouds, info);
  scn = { ...scn, lang: opts.lang, chapters };
  if (chapters.length === 0) {
    delete scn.chapters;
  }
  let paced = paceChapters(scn, opts);
  // A chapter too short for its own camera move: the weaker of it and its successor goes.
  for (;;) {
    const timeline = parseScenario(paced.scenario).chapters;
    const i = timeline.findIndex((ch) => ch.to - ch.at < opts.minChapterSec);
    if (i < 0) {
      break;
    }
    const pair = [timeline[i], timeline[i + 1]].filter((ch) => ch !== undefined);
    const [a, b] = pair.map((ch) => ({
      ch,
      at: isoDate(ch.dateMs),
      ...info.get(isoDate(ch.dateMs)),
    }));
    if (a && b && (a.island || b.island) && (a.ch.index > 0 || b.island)) {
      // Too close for a camera move each, but an island arrival is a beat: one chapter tells both.
      const text = TEXT[opts.lang];
      const strong = (b.score ?? 0) > (a.score ?? 0) ? b : a;
      const both = a.island && b.island;
      const count = both ? (a.count ?? 0) + (b.count ?? 0) : (strong.count ?? 0);
      const opening = chapters.find((ch) => ch.at === a.at);
      const merged: ScenarioChapter =
        a.ch.index === 0 && opening
          ? { ...opening, caption: text.after(opening.caption ?? opening.title, b.ch.title) }
          : {
              at: a.at,
              title: both ? clip(`${a.island}${text.and}${b.island}`) : strong.ch.title,
              caption: text.after(a.ch.title, b.ch.title),
              ...(both
                ? { stat: text.plus(count) }
                : strong.ch.stat
                  ? { stat: strong.ch.stat }
                  : {}),
            };
      info.set(a.at, { score: Math.max(a.score ?? 0, b.score ?? 0), count });
      warnings.push(`chapters ${a.at} and ${b.at} merged: shorter than ${opts.minChapterSec} s`);
      chapters = chapters
        .filter((ch) => ch.at !== b.at)
        .map((ch) => (ch.at === a.at ? merged : ch));
    } else {
      const weakest = pair
        .filter((ch) => ch.index > 0)
        .sort(
          (x, y) =>
            (info.get(isoDate(x.dateMs))?.score ?? 0) - (info.get(isoDate(y.dateMs))?.score ?? 0),
        )[0];
      if (!weakest) {
        break;
      }
      const at = isoDate(weakest.dateMs);
      warnings.push(`chapter ${at} dropped: shorter than ${opts.minChapterSec} s`);
      chapters = chapters.filter((ch) => ch.at !== at);
    }
    paced = paceChapters({ ...scn, chapters }, opts);
  }
  scn = paced.scenario;
  if (Math.abs(paced.totalSec - opts.targetSec) > 2) {
    warnings.push(
      `total ${paced.totalSec.toFixed(1)} s misses the ${opts.targetSec} s target: ` +
        "the fixed costs (chapters, cascades, blasts) or the time-lapse cap decide it",
    );
  }
  return {
    scenario: paced.scenario,
    report: {
      eventsBefore: countEvents(input),
      eventsAfter: countEvents(paced.scenario),
      beatsBefore: countBeats(input),
      beatsAfter: countBeats(paced.scenario),
      clouds: marked.clouds,
      chapterSec: parseScenario(paced.scenario).chapters.map((ch) => ch.to - ch.at),
      nodesBefore: nodeCount(input),
      nodesAfter: nodeCount(paced.scenario),
      churnMerged: churn.merged,
      stagingFolded: staging.merged,
      pruned: pruned.pruned,
      droppedCities: pruned.droppedCities,
      moves: groupMoves(moves),
      cut: capped.cut,
      emptyLinks,
      chapters,
      durationSec: paced.scenario.durationSec,
      maxGapSec: paced.scenario.maxGapSec ?? opts.maxGapSec,
      totalSec: paced.totalSec,
      warnings,
    },
  };
}
