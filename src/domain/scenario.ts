import type { SnapshotMessage } from "@proxy/protocol";
import { loadWorld } from "../loaders/loadWorld";
import { BLAST_SEC, BLAST_SINK_DELAY } from "./blast";
import type { CityMeta, GraphNode, InterCityLink, NodeType, ResolvedLink, World } from "./types";

/**
 * A replay scenario: the union of everything the infrastructure ever held over a
 * period, each piece dated. The replay lays the union out once and shows, at
 * each instant, what existed then (`docs/replay.md`).
 */
export interface Lifetime {
  /** ISO date; omitted = there from the start. */
  since?: string;
  /** ISO date; omitted = still there at the end. */
  until?: string;
}

export interface ScenarioLink extends Lifetime {
  /** Node id in the same city. */
  to: string;
}

export interface ScenarioNode extends Omit<GraphNode, "links">, Lifetime {
  links?: (string | ScenarioLink)[];
}

export interface ScenarioCity extends Lifetime {
  id: string;
  name: string;
  description?: string;
  biome?: string;
  /** Machine capacity: `memMb` sizes the island. */
  meta?: CityMeta;
  nodes: ScenarioNode[];
}

export interface Scenario {
  title: string;
  subtitle?: string;
  /** ISO dates bounding the timeline. */
  start: string;
  end: string;
  /** Video seconds spent between `start` and `end`. */
  durationSec: number;
  /** Wide shot before the first date / after the last one. */
  introSec?: number;
  outroSec?: number;
  /** Video seconds a building takes to rise or fall. */
  rampSec?: number;
  /** ISO instant the sun is frozen at. */
  sunTime?: string;
  cities: ScenarioCity[];
  links?: (InterCityLink & Lifetime)[];
}

export const DEFAULT_INTRO_SEC = 3;
export const DEFAULT_OUTRO_SEC = 4;
export const DEFAULT_RAMP_SEC = 1.2;

/** A scenario resolved against its own clock: every lifetime in video seconds. */
export interface Timeline {
  scenario: Scenario;
  world: World;
  links: ResolvedLink[];
  cityMeta: Map<string, CityMeta>;
  totalSec: number;
  rampSec: number;
  /** cityId → [appear, vanish) in video seconds. */
  cities: Map<string, Span>;
  /** `cityId/nodeId` → span, clipped to its city's. */
  nodes: Map<string, Span>;
  /** `linkKey` → span, clipped to both ends'. */
  linkSpans: Map<string, Span>;
  events: TimelineEvent[];
}

export interface Span {
  from: number;
  to: number;
}

export interface TimelineEvent {
  at: number;
  kind: "add" | "remove";
  what: "city" | "node" | "link";
  /** cityId, address or linkKey. */
  id: string;
  /** City the camera should look at. */
  cityId: string;
}

export interface Presence {
  cities: Map<string, number>;
  nodes: Map<string, number>;
  links: Map<string, number>;
  /** Leaving nodes → seconds since they left: they blow up instead of sinking. */
  blasts: Map<string, number>;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

function linkKeyOf(l: ResolvedLink): string {
  return `${l.fromCityId}/${l.fromNodeId}->${l.toCityId}/${l.toNodeId}`;
}

function parseDate(value: string, where: string, errors: string[]): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    errors.push(`${where}: invalid date "${value}"`);
    return 0;
  }
  return ms;
}

/** Validates the JSON and resolves every lifetime to video seconds. */
export function parseScenario(json: unknown): Timeline {
  if (!json || typeof json !== "object") {
    throw new ScenarioError("Scenario must be a JSON object");
  }
  const scn = json as Scenario;
  const errors: string[] = [];
  if (typeof scn.title !== "string") {
    errors.push("Missing title");
  }
  if (!Array.isArray(scn.cities)) {
    throw new ScenarioError("Missing cities");
  }
  if (!(scn.durationSec > 0)) {
    errors.push("durationSec must be > 0");
  }
  const start = parseDate(scn.start, "start", errors);
  const end = parseDate(scn.end, "end", errors);
  if (end <= start) {
    errors.push("end must be after start");
  }
  const intro = scn.introSec ?? DEFAULT_INTRO_SEC;
  const outro = scn.outroSec ?? DEFAULT_OUTRO_SEC;
  const rampSec = scn.rampSec ?? DEFAULT_RAMP_SEC;
  const toVideo = (ms: number) => intro + ((ms - start) / (end - start)) * scn.durationSec;
  const totalSec = intro + scn.durationSec + outro;
  const spanOf = (life: Lifetime, where: string, within?: Span): Span => {
    let from = life.since ? toVideo(parseDate(life.since, `${where}.since`, errors)) : 0;
    let to = life.until ? toVideo(parseDate(life.until, `${where}.until`, errors)) : Infinity;
    if (within) {
      from = Math.max(from, within.from);
      to = Math.min(to, within.to);
    }
    return { from, to };
  };

  const cities = new Map<string, Span>();
  const nodes = new Map<string, Span>();
  const linkSpans = new Map<string, Span>();
  const cityMeta = new Map<string, CityMeta>();
  const world: World = { cities: [], links: [] };
  for (const c of scn.cities) {
    const citySpan = spanOf(c, c.id);
    cities.set(c.id, citySpan);
    if (c.meta) {
      cityMeta.set(c.id, c.meta);
    }
    for (const n of c.nodes ?? []) {
      nodes.set(`${c.id}/${n.id}`, spanOf(n, `${c.id}/${n.id}`, citySpan));
    }
    world.cities.push({
      id: c.id,
      name: c.name ?? c.id,
      ...(c.description ? { description: c.description } : {}),
      ...(c.biome ? { biome: c.biome as World["cities"][number]["biome"] } : {}),
      nodes: (c.nodes ?? []).map((n) => {
        const { since: _s, until: _u, links: raw, ...node } = n;
        const links: string[] = [];
        for (const l of raw ?? []) {
          const to = typeof l === "string" ? l : l.to;
          links.push(to);
          // Clipped to both ends below, once every node is known.
          const key = `${c.id}/${n.id}->${c.id}/${to}`;
          linkSpans.set(key, spanOf(typeof l === "string" ? {} : l, key));
        }
        return { ...node, links };
      }),
    });
  }
  for (const l of scn.links ?? []) {
    world.links!.push({ from: l.from, to: l.to });
    linkSpans.set(`${l.from}->${l.to}`, spanOf(l, `${l.from}->${l.to}`));
  }
  if (errors.length > 0) {
    throw new ScenarioError(errors.join("\n"));
  }

  let links: ResolvedLink[];
  try {
    links = loadWorld(world).links;
  } catch (e) {
    throw new ScenarioError(e instanceof Error ? e.message : String(e));
  }
  // A link lives only while both of its ends do.
  for (const l of links) {
    const key = linkKeyOf(l);
    const span = linkSpans.get(key) ?? { from: 0, to: Infinity };
    const a = nodes.get(`${l.fromCityId}/${l.fromNodeId}`);
    const b = nodes.get(`${l.toCityId}/${l.toNodeId}`);
    linkSpans.set(key, {
      from: Math.max(span.from, a?.from ?? 0, b?.from ?? 0),
      to: Math.min(span.to, a?.to ?? Infinity, b?.to ?? Infinity),
    });
  }

  const events: TimelineEvent[] = [];
  const push = (span: Span, what: TimelineEvent["what"], id: string, cityId: string) => {
    if (span.from > 0) {
      events.push({ at: span.from, kind: "add", what, id, cityId });
    }
    if (Number.isFinite(span.to)) {
      events.push({ at: span.to, kind: "remove", what, id, cityId });
    }
  };
  for (const [id, span] of cities) {
    push(span, "city", id, id);
  }
  for (const [addr, span] of nodes) {
    push(span, "node", addr, addr.split("/")[0]!);
  }
  for (const l of links) {
    push(linkSpans.get(linkKeyOf(l))!, "link", linkKeyOf(l), l.fromCityId);
  }
  events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  return {
    scenario: scn,
    world,
    links,
    cityMeta,
    totalSec,
    rampSec,
    cities,
    nodes,
    linkSpans,
    events,
  };
}

/** 0 → 1 over the ramp after `from`, back to 0 over `exit` (default the ramp) after `to`. */
export function presenceOf(span: Span, t: number, ramp: number, exit = ramp): number {
  if (t < span.from || t >= span.to + exit) {
    return 0;
  }
  const up = ramp > 0 ? Math.min(1, (t - span.from) / ramp) : 1;
  const down = t < span.to ? 1 : exit > 0 ? 1 - (t - span.to) / exit : 0;
  return Math.max(0, Math.min(up, down));
}

/** Everything on screen at `t`, with how far along its rise or fall it is. */
export function presenceAt(tl: Timeline, t: number): Presence {
  const pick = (spans: Map<string, Span>, exit: number, delay = 0) => {
    const out = new Map<string, number>();
    for (const [id, span] of spans) {
      const p = presenceOf({ from: span.from, to: span.to + delay }, t, tl.rampSec, exit);
      if (p > 0) {
        out.set(id, p);
      }
    }
    return out;
  };
  const nodes = pick(tl.nodes, Math.max(tl.rampSec, BLAST_SEC));
  const blasts = new Map<string, number>();
  for (const addr of nodes.keys()) {
    const to = tl.nodes.get(addr)!.to;
    if (t >= to) {
      blasts.set(addr, t - to);
    }
  }
  return {
    // An island sinks once its buildings have blown up.
    cities: pick(tl.cities, tl.rampSec, BLAST_SINK_DELAY),
    nodes,
    links: pick(tl.linkSpans, tl.rampSec),
    blasts,
  };
}

/** Changes only when something enters or leaves the scene: the key the layout is memoised on. */
export function activeKey(p: Presence): string {
  return [
    [...p.cities.keys()].sort().join(","),
    [...p.nodes.keys()].sort().join(","),
    [...p.links.keys()].sort().join(","),
  ].join("|");
}

/** Scenario date shown at video second `t`, clamped to the period. */
export function dateAt(tl: Timeline, t: number): Date {
  const scn = tl.scenario;
  const start = Date.parse(scn.start);
  const end = Date.parse(scn.end);
  const intro = scn.introSec ?? DEFAULT_INTRO_SEC;
  const f = Math.max(0, Math.min(1, (t - intro) / scn.durationSec));
  return new Date(start + f * (end - start));
}

const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>(["app", "db", "cache", "queue"]);

/**
 * A scenario skeleton from a proxy snapshot: today's infrastructure, everything there from
 * `start`. Dating each piece (`since` / `until`) is left to the author.
 */
export function scenarioFromSnapshot(
  snapshot: Pick<SnapshotMessage, "meta" | "cityMeta">,
  { title, start, end }: { title: string; start: string; end: string },
): Scenario {
  const cities = new Map<string, ScenarioCity>();
  const links: InterCityLink[] = [];
  const addresses = Object.keys(snapshot.meta).sort();
  const visible = new Set(addresses.filter((addr) => !snapshot.meta[addr]!.hidden));
  for (const addr of visible) {
    const meta = snapshot.meta[addr]!;
    const [cityId, id] = splitAddress(addr);
    let city = cities.get(cityId);
    if (!city) {
      const cityMeta = snapshot.cityMeta[cityId];
      city = { id: cityId, name: cityMeta?.label ?? cityId, nodes: [] };
      if (cityMeta) {
        city.meta = cityMeta;
      }
      cities.set(cityId, city);
    }
    const local: string[] = [];
    for (const to of meta.links ?? []) {
      if (!visible.has(to)) {
        continue;
      }
      const [toCity, toId] = splitAddress(to);
      if (toCity === cityId) {
        local.push(toId);
      } else {
        links.push({ from: addr, to });
      }
    }
    const node: ScenarioNode = {
      id,
      type: NODE_TYPES.has(meta.type) ? (meta.type as NodeType) : "app",
      label: meta.label ?? id,
      links: local,
    };
    for (const key of ["description", "group", "ingress"] as const) {
      if (meta[key] !== undefined) {
        Object.assign(node, { [key]: meta[key] });
      }
    }
    city.nodes.push(node);
  }
  return {
    title,
    start,
    end,
    durationSec: 40,
    cities: [...cities.values()],
    ...(links.length > 0 ? { links } : {}),
  };
}

function splitAddress(addr: string): [string, string] {
  const slash = addr.indexOf("/");
  return [addr.slice(0, slash), addr.slice(slash + 1)];
}
