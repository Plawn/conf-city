import { MAST_HEIGHT } from "../layout/cableway";
import { cityAltitude } from "../layout/cloud";
import type { WorldLayout } from "../layout/types";
import type { Timeline, TimelineEvent } from "./scenario";

/**
 * The replay's camera operator: a list of framings over video time, and a pure
 * pose for any instant, so a scrubbed frame and a rendered frame agree.
 */
export interface ShotKey {
  /** Video second the camera starts moving toward this framing. */
  t: number;
  lookAt: [number, number, number];
  /** Camera–target distance. */
  distance: number;
  /** Seconds the move into this framing takes: longer the farther it goes. */
  duration: number;
}

export interface CameraPose {
  position: [number, number, number];
  lookAt: [number, number, number];
}

/** Events closer than this share a shot. */
const CLUSTER_GAP = 2;
/** A shot never covers more than this, however busy the year. */
const MAX_CLUSTER = 6;
/** Arrive before the first building of a shot starts rising. */
const LEAD = 1.6;
/** Linger once the last one is up. */
const HOLD = 1.2;
/** A quiet stretch longer than this (time-lapses excluded) may get a wide shot. */
const WIDE_GAP = 8;
/** A wide shot is never held for less. */
const WIDE_MIN_HOLD = 3;
/** Once a move lands, the camera holds at least this long before the next one. */
export const MIN_HOLD = 4;
/** A city is framed when it carries more than this share of the busiest one's buildings. */
const DOMINANT = 0.3;
/** A burst's move may land this late (or half-way through it) when the previous framing still holds. */
const LATE = 0.6;
/** A demolition shot holds until the fireball has died down. */
const BLAST_HOLD = 1.6;
/** Seconds a short camera move takes; a long one stretches up to `MAX_TRANSITION`. */
export const TRANSITION = 1.6;
const MAX_TRANSITION = 3.4;
/** Zoom-out during a long move (van Wijk & Nuij `rho`): higher climbs more. */
const RHO = 1.3;
/** A hold slowly orbits the look-at, easing toward `MAX_ORBIT_DEG` per shot; moves keep the heading. */
export const ORBIT_DEG_PER_SEC = 1.3;
const MAX_ORBIT_DEG = 45;
/** Close-ups look across the street, wide shots look down from higher. */
const LOW_ELEVATION = (26 * Math.PI) / 180;
const HIGH_ELEVATION = (40 * Math.PI) / 180;
const MIN_DISTANCE = 14;
/** A held shot slowly pushes in by up to this fraction. */
const DRIFT = 0.1;
const DRIFT_SEC = 8;
/** Half-width (s) of the window the raw path is averaged over: no velocity jump anywhere. */
const SMOOTH_SEC = 0.5;
const SMOOTH_SAMPLES = 11;

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Altitude range: sea level, or a cloud service's deck. */
  minY: number;
  maxY: number;
}

type Framing = Omit<ShotKey, "t" | "duration">;

function frame(box: Box | null): Framing | null {
  if (!box) {
    return null;
  }
  const span = Math.max(box.maxX - box.minX, box.maxZ - box.minZ, 4);
  return {
    lookAt: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2],
    distance: Math.max(MIN_DISTANCE, (span + 10) * 1.05),
  };
}

function grow(box: Box | null, minX: number, maxX: number, minZ: number, maxZ: number, y = 0): Box {
  return box
    ? {
        minX: Math.min(box.minX, minX),
        maxX: Math.max(box.maxX, maxX),
        minZ: Math.min(box.minZ, minZ),
        maxZ: Math.max(box.maxZ, maxZ),
        minY: Math.min(box.minY, y),
        maxY: Math.max(box.maxY, y),
      }
    : { minX, maxX, minZ, maxZ, minY: y, maxY: y };
}

/** A cloud service or one of its buildings arriving: it comes down from the sky in a shot of its own. */
function cloudArrival(layout: WorldLayout, e: TimelineEvent) {
  return e.kind === "add" && e.what !== "link" && !!layout.cities.get(e.cityId)?.cloud;
}

/** The cloud and the nearest mast of its cable car, so the line it strings is in the frame; a cloud with no cable car takes the nearest island standing (`ground`), never empty sea. */
function cloudFrame(layout: WorldLayout, cityId: string, ground: Iterable<string>) {
  const city = layout.cities.get(cityId);
  let box = citiesBox(layout, [cityId]);
  if (!city || !box) {
    return null;
  }
  let mast: [number, number] | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const way of layout.cableways) {
    const d = Math.hypot(way.base[0] - city.center[0], way.base[1] - city.center[1]);
    if (way.cloud === cityId && d < bestD) {
      bestD = d;
      mast = way.base;
    }
  }
  if (mast) {
    return frame(grow(box, mast[0] - 1, mast[0] + 1, mast[1] - 1, mast[1] + 1, MAST_HEIGHT));
  }
  let island: string | null = null;
  for (const id of ground) {
    const g = layout.cities.get(id);
    if (!g || g.cloud) {
      continue;
    }
    const d = Math.hypot(g.center[0] - city.center[0], g.center[1] - city.center[1]);
    if (d < bestD) {
      bestD = d;
      island = id;
    }
  }
  if (island) {
    box = grow(box, ...boxOf(citiesBox(layout, [island])!));
  }
  return frame(box);
}

function boxOf(b: Box): [number, number, number, number, number] {
  return [b.minX, b.maxX, b.minZ, b.maxZ, b.minY];
}

function citiesBox(layout: WorldLayout, ids: Iterable<string>): Box | null {
  let box: Box | null = null;
  for (const id of ids) {
    const b = layout.cities.get(id)?.bounds;
    if (b) {
      box = grow(
        box,
        b.cx - b.width / 2,
        b.cx + b.width / 2,
        b.cz - b.height / 2,
        b.cz + b.height / 2,
        cityAltitude(layout.cities.get(id)),
      );
    }
  }
  return box;
}

function aliveAt(tl: Timeline, t: number): string[] {
  return [...tl.cities].filter(([, s]) => s.from <= t && t < s.to).map(([id]) => id);
}

/** Close-up on the buildings involved, wherever they stand; the islands when one arrives or leaves. */
function clusterFrame(tl: Timeline, layout: WorldLayout, events: TimelineEvent[]) {
  const cityIds = new Set(events.map((e) => e.cityId));
  const addrs = new Set(events.filter((e) => e.what === "node").map((e) => e.id));
  if (addrs.size > 0 && events.every((e) => e.what !== "city")) {
    let box: Box | null = null;
    for (const n of layout.nodes) {
      if (addrs.has(`${n.cityId}/${n.id}`)) {
        const [x, y, z] = n.position;
        box = grow(box, x - 3, x + 3, z - 3, z + 3, y);
      }
    }
    if (box) {
      return frame(box);
    }
  }
  return frame(citiesBox(layout, cityIds)) ?? frame(citiesBox(layout, tl.cities.keys()));
}

interface Segment {
  /** `shot` a burst (no chapters), `chapter` its opening move, `aside` its demolition elsewhere. */
  kind: "intro" | "shot" | "chapter" | "aside" | "outro";
  events: TimelineEvent[];
  /** Video second the move should land; may slip until `latest`. */
  land: number;
  latest: number;
  /** The camera stays at least until then (a blast dying down, a cloud landing). */
  until: number;
  /** The action is over: a quiet stretch from there may get a wide shot. */
  end: number;
  /** Cloud service framed at its altitude. */
  sky: string | null;
  /** Cities framed together, overriding the events' own focus. */
  cities: string[] | null;
  fixed: Framing | null;
  /** Late landing accepted: no merge could make room. */
  forced: boolean;
}

interface Scheduled {
  seg: Segment;
  framing: Framing;
  start: number;
  duration: number;
}

/** Video seconds of `[a, b)` spent in a time-lapse: the date leaping faster than the base pace. */
function timeLapseSec(tl: Timeline, a: number, b: number): number {
  const { ms, sec, rate } = tl.clock;
  let total = 0;
  for (let i = 1; i < ms.length; i++) {
    const s0 = sec[i - 1]!;
    const s1 = sec[i]!;
    if (s1 > s0 && (ms[i]! - ms[i - 1]!) * rate > (s1 - s0) * 1.5) {
      total += Math.max(0, Math.min(b, s1) - Math.max(a, s0));
    }
  }
  return total;
}

/** Framings for the whole replay; `layout` is the union, laid out once. */
export function planShots(tl: Timeline, layout: WorldLayout): ShotKey[] {
  const intro = tl.scenario.introSec ?? 3;
  const outroAt = tl.outroAt;
  const wideAt = (t: number) => {
    const alive = aliveAt(tl, t);
    return frame(citiesBox(layout, alive.length > 0 ? alive : tl.cities.keys()));
  };
  const shot = (events: TimelineEvent[], land: number, latest: number): Segment => {
    const first = events[0]!;
    const last = events[events.length - 1]!.at;
    const sky = cloudArrival(layout, first) ? first.cityId : null;
    const end = last + tl.rampSec + HOLD;
    const blast = events.some((e) => e.kind === "remove")
      ? Math.max(...events.filter((e) => e.kind === "remove").map((e) => e.at)) + BLAST_HOLD
      : 0;
    return {
      kind: "shot",
      events,
      land,
      latest,
      until: Math.max(blast, sky ? end : 0),
      end: Math.max(end, blast),
      sky,
      cities: null,
      fixed: null,
      forced: false,
    };
  };
  const framingOf = (s: Segment): Framing | null =>
    s.fixed ??
    (s.sky
      ? cloudFrame(layout, s.sky, aliveAt(tl, s.land))
      : s.cities
        ? frame(citiesBox(layout, s.cities))
        : eventsFrame(tl, layout, s.events));

  const segs: Segment[] = [];
  const opening = wideAt(intro);
  if (opening) {
    segs.push({
      kind: "intro",
      events: [],
      land: 0,
      latest: 0,
      until: 0,
      end: intro,
      sky: null,
      cities: null,
      fixed: { ...opening, distance: opening.distance * 1.5 },
      forced: false,
    });
  }
  const events = tl.events.filter((e) => e.at < outroAt);
  const firstChapter = tl.chapters[0]?.at ?? Number.POSITIVE_INFINITY;
  for (const cluster of legacyClusters(
    layout,
    events.filter((e) => e.at < firstChapter),
  )) {
    const at = cluster[0]!.at - LEAD + TRANSITION;
    const span = cluster[cluster.length - 1]!.at - cluster[0]!.at;
    segs.push(shot(cluster, at, at + Math.max(LATE, span / 2)));
  }
  for (const ch of tl.chapters) {
    const own = events.filter((e) => ch.at <= e.at && e.at < ch.to);
    if (own.length === 0) {
      continue;
    }
    /** A chapter's holds never delay the next title card. */
    const inChapter = (seg: Segment, kind: "chapter" | "aside"): Segment => ({
      ...seg,
      kind,
      until: Math.min(seg.until, ch.to - MAX_TRANSITION),
    });
    const buildings = own.filter((e) => e.what !== "link");
    const rising = buildings.filter((e) => e.kind === "add");
    const built = focus(rising);
    const foreign = buildings.filter(
      (e) => e.kind === "remove" && !rising.some((r) => r.cityId === e.cityId),
    );
    if (built.length === 0 || foreign.length === 0) {
      segs.push(inChapter(shot(own, ch.at, ch.at + ch.holdSec), "chapter"));
      continue;
    }
    // Rises framed first; a demolition elsewhere widens to both cities when it comes.
    const rises = own.filter((e) => !foreign.includes(e));
    segs.push(inChapter(shot(rises, ch.at, ch.at + ch.holdSec), "chapter"));
    const at = foreign[0]!.at - LEAD + TRANSITION;
    const both = inChapter(shot(foreign, at, at + LATE), "aside");
    both.cities = [...new Set([...built, ...focus(foreign)])];
    segs.push(both);
  }
  segs.sort((a, b) => a.land - b.land);
  const closing = wideAt(outroAt);
  if (closing) {
    const at = outroAt + TRANSITION;
    segs.push({
      kind: "outro",
      events: [],
      land: at,
      latest: Math.max(at, tl.totalSec - 1),
      until: 0,
      end: tl.totalSec,
      sky: null,
      cities: null,
      fixed: closing,
      forced: false,
    });
  }

  /** Earliest each move may start and when it lands; the first segment that cannot land in time. */
  const schedule = () => {
    const out: Scheduled[] = [];
    let conflict = -1;
    let conflictLand = 0;
    for (const [i, seg] of segs.entries()) {
      const framing = framingOf(seg);
      if (!framing) {
        continue;
      }
      const prev = out[out.length - 1];
      if (!prev) {
        out.push({ seg, framing, start: 0, duration: TRANSITION });
        continue;
      }
      const duration = moveDuration(prev.framing, framing);
      const landed = prev.start + prev.duration;
      const hold = prev.seg.kind === "intro" ? 0 : MIN_HOLD;
      const start = Math.max(seg.land - duration, landed + hold, prev.seg.until);
      if (conflict < 0 && !seg.forced && start + duration > seg.latest + 1e-9) {
        conflict = i;
        conflictLand = start + duration;
      }
      out.push({ seg, framing, start, duration });
    }
    return { out, conflict, conflictLand };
  };
  const absorb = (into: Segment, from: Segment) => {
    into.events = [...into.events, ...from.events].sort((a, b) => a.at - b.at);
    if (into.cities || from.cities) {
      into.cities = [
        ...new Set([
          ...(into.cities ?? focus(into.events)),
          ...(from.cities ?? focus(from.events)),
        ]),
      ];
    }
    into.until = Math.max(into.until, from.until);
    into.end = Math.max(into.end, from.end);
  };
  // Too close to hold the previous framing `MIN_HOLD` seconds: one framing covers both.
  for (let guard = 0; guard < 4 * segs.length + 4; guard++) {
    const { conflict, conflictLand } = schedule();
    if (conflict < 0) {
      break;
    }
    const seg = segs[conflict]!;
    const prev = segs[conflict - 1];
    const before = segs[conflict - 2];
    const framed = (x: Segment | undefined) => !!x && x.kind !== "intro" && x.kind !== "outro";
    const demolition = prev?.kind === "shot" && prev.events.every((e) => e.kind === "remove");
    if (demolition && seg.kind === "shot" && conflictLand < seg.events[seg.events.length - 1]!.at) {
      // A demolition keeps its close-up: the next burst is caught under way.
      seg.forced = true;
    } else if (
      (seg.kind === "outro" || (seg.kind === "chapter" && prev?.kind === "aside")) &&
      framed(prev) &&
      framed(before)
    ) {
      // The next chapter lands on time: the aside before it folds into its own chapter.
      absorb(before!, prev!);
      segs.splice(conflict - 1, 1);
    } else if (framed(seg) && framed(prev)) {
      const weight = (x: Segment) => x.events.filter((e) => e.what !== "link").length;
      if (
        seg.kind !== "aside" &&
        prev!.kind !== "aside" &&
        weight(prev!) < weight(seg) &&
        (framed(before) || before?.kind === "intro")
      ) {
        // The lighter burst gives way: the framing before it keeps holding, the heavier lands on time.
        if (framed(before)) {
          absorb(before!, prev!);
        }
        segs.splice(conflict - 1, 1);
      } else {
        absorb(prev!, seg);
        segs.splice(conflict, 1);
      }
    } else {
      seg.forced = true;
    }
  }
  const planned = schedule().out;

  // A long quiet stretch gets a wide shot, if it can hold it; a time-lapse keeps the framing.
  const keys: ShotKey[] = [];
  for (const [i, s] of planned.entries()) {
    const next = planned[i + 1];
    let item = s;
    const last = keys[keys.length - 1];
    if (last) {
      // A wide shot may have been inserted: the move back leaves from it.
      const duration = moveDuration(last, s.framing);
      const target = s.start + s.duration;
      item = { ...s, start: Math.max(target - duration, last.t + last.duration), duration };
    }
    keys.push({ t: item.start, ...item.framing, duration: item.duration });
    if (!next || next.seg.kind === "outro" || s.seg.kind === "intro") {
      continue;
    }
    const quietFrom = Math.max(s.seg.end, s.seg.until);
    const quietTo = next.seg.kind === "shot" ? next.seg.events[0]!.at : next.seg.land;
    if (quietTo - quietFrom - timeLapseSec(tl, quietFrom, quietTo) <= WIDE_GAP) {
      continue;
    }
    const wide = wideAt(quietFrom);
    if (!wide) {
      continue;
    }
    const landed = item.start + item.duration;
    const start = Math.max(quietFrom, landed + MIN_HOLD, s.seg.until);
    const duration = moveDuration(item.framing, wide);
    const back = moveDuration(wide, next.framing);
    const nextLand = next.start + next.duration;
    if (nextLand - back - (start + duration) >= Math.max(MIN_HOLD, WIDE_MIN_HOLD)) {
      keys.push({ t: start, ...wide, duration });
    }
  }
  return keys;
}

/** Bursts of events as before chapters existed: demolitions and cloud arrivals apart. */
function legacyClusters(layout: WorldLayout, events: TimelineEvent[]): TimelineEvent[][] {
  const clusters: TimelineEvent[][] = [];
  /** Open shot per cloud service: its buildings join it even when the islands keep busy meanwhile. */
  const skies = new Map<string, TimelineEvent[]>();
  let current: TimelineEvent[] | undefined;
  for (const e of events) {
    if (cloudArrival(layout, e)) {
      const sky = skies.get(e.cityId);
      if (sky && e.at - sky[0]!.at < MAX_CLUSTER) {
        sky.push(e);
      } else {
        const opened = [e];
        skies.set(e.cityId, opened);
        clusters.push(opened);
      }
      continue;
    }
    const first = current?.[0];
    const last = current?.[current.length - 1];
    if (
      current &&
      first &&
      last &&
      (e.kind === "remove") === (first.kind === "remove") &&
      e.at - last.at < CLUSTER_GAP &&
      e.at - first.at < MAX_CLUSTER
    ) {
      current.push(e);
    } else {
      current = [e];
      clusters.push(current);
    }
  }
  return clusters;
}

/** Cities carrying the bulk of the buildings that change: a lone side job stays off frame. */
function focus(events: TimelineEvent[]): string[] {
  const weights = new Map<string, number>();
  const buildings = events.filter((e) => e.what !== "link");
  for (const e of buildings.length > 0 ? buildings : events) {
    // An island arriving outweighs a few buildings elsewhere.
    weights.set(e.cityId, (weights.get(e.cityId) ?? 0) + (e.what === "city" ? 3 : 1));
  }
  const max = Math.max(0, ...weights.values());
  return [...weights].filter(([, w]) => w > max * DOMINANT).map(([id]) => id);
}

/** Several cities: frame them together; one: close-up on what changes there. */
function eventsFrame(tl: Timeline, layout: WorldLayout, events: TimelineEvent[]) {
  const cities = focus(events);
  if (cities.length > 1) {
    return frame(citiesBox(layout, cities));
  }
  return clusterFrame(
    tl,
    layout,
    events.filter((e) => e.cityId === cities[0]),
  );
}

function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** Optimal zoom-and-pan path between two framings (van Wijk & Nuij 2003, as d3.interpolateZoom). */
function zoomPath(a: Framing, b: Framing) {
  const dx = b.lookAt[0] - a.lookAt[0];
  const dz = b.lookAt[2] - a.lookAt[2];
  const w0 = a.distance;
  const w1 = b.distance;
  const d2 = dx * dx + dz * dz;
  const r2 = RHO * RHO;
  if (d2 < 1e-6) {
    const S = Math.log(w1 / w0) / RHO;
    return {
      length: Math.abs(S),
      at: (k: number) => ({ u: k, w: w0 * Math.exp(RHO * k * S) }),
    };
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d2) / (2 * w0 * r2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d2) / (2 * w1 * r2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  const c0 = Math.cosh(r0);
  return {
    length: S,
    at: (k: number) => {
      const s = k * S;
      return {
        u: (w0 / (r2 * d1)) * (c0 * Math.tanh(RHO * s + r0) - Math.sinh(r0)),
        w: (w0 * c0) / Math.cosh(RHO * s + r0),
      };
    },
  };
}

function moveDuration(a: Framing, b: Framing): number {
  return Math.min(MAX_TRANSITION, TRANSITION + 0.7 * Math.max(0, zoomPath(a, b).length - 0.6));
}

/** Distance once a shot has been held `held` seconds: a slow push-in. */
function drifted(distance: number, held: number): number {
  return distance * (1 - DRIFT * (1 - Math.exp(-Math.max(0, held) / DRIFT_SEC)));
}

/** Degrees turned after holding `held` seconds: starts at the full rate, bounded per shot. */
function orbited(held: number): number {
  const h = Math.max(0, held);
  return MAX_ORBIT_DEG * (1 - Math.exp((-h * ORBIT_DEG_PER_SEC) / MAX_ORBIT_DEG));
}

/** Heading (deg) each key's hold starts from: what the earlier holds turned. */
const headings = new WeakMap<ShotKey[], number[]>();

function headingsOf(keys: ShotKey[]): number[] {
  let out = headings.get(keys);
  if (!out) {
    out = [0];
    for (let i = 1; i < keys.length; i++) {
      const prev = keys[i - 1]!;
      out.push(out[i - 1]! + orbited(keys[i]!.t - (prev.t + prev.duration)));
    }
    headings.set(keys, out);
  }
  return out;
}

interface RawPose {
  x: number;
  y: number;
  z: number;
  logDistance: number;
  /** Orbit heading, degrees. */
  heading: number;
}

/** Last key starting at or before `t` (0 before the first). */
function keyIndex(keys: ShotKey[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid]!.t <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Unsmoothed framing at `t`: held (pushing in), or flying the zoom path toward the next. */
function rawAt(keys: ShotKey[], t: number, out: RawPose) {
  const i = keyIndex(keys, t);
  const to = keys[i]!;
  const from = keys[i - 1];
  const land = to.t + to.duration;
  if (!from || t >= land || t < to.t) {
    const held = from || t >= to.t ? t - land : 0;
    out.x = to.lookAt[0];
    out.y = to.lookAt[1];
    out.z = to.lookAt[2];
    out.logDistance = Math.log(drifted(to.distance, held));
    out.heading = headingsOf(keys)[i]! + orbited(held);
    return;
  }
  const start: Framing = {
    lookAt: from.lookAt,
    distance: drifted(from.distance, to.t - (from.t + from.duration)),
  };
  const { u, w } = zoomPath(start, to).at(smooth((t - to.t) / to.duration));
  out.x = start.lookAt[0] + (to.lookAt[0] - start.lookAt[0]) * u;
  out.y = start.lookAt[1] + (to.lookAt[1] - start.lookAt[1]) * u;
  out.z = start.lookAt[2] + (to.lookAt[2] - start.lookAt[2]) * u;
  out.logDistance = Math.log(w);
  out.heading = headingsOf(keys)[i]!;
}

const SAMPLE: RawPose = { x: 0, y: 0, z: 0, logDistance: 0, heading: 0 };

/** Pose at video second `t`: the zoom path averaged over a short window, orbiting while it holds. */
export function shotAt(keys: ShotKey[], t: number): CameraPose | null {
  if (keys.length === 0) {
    return null;
  }
  let x = 0;
  let y = 0;
  let z = 0;
  let logDistance = 0;
  let heading = 0;
  let total = 0;
  for (let k = 0; k < SMOOTH_SAMPLES; k++) {
    const o = (k / (SMOOTH_SAMPLES - 1)) * 2 - 1;
    // Hann weights: a smooth kernel keeps the averaged path smooth too.
    const weight = 0.5 + 0.5 * Math.cos(Math.PI * o);
    if (weight <= 0) {
      continue;
    }
    rawAt(keys, Math.max(0, t + o * SMOOTH_SEC), SAMPLE);
    x += SAMPLE.x * weight;
    y += SAMPLE.y * weight;
    z += SAMPLE.z * weight;
    logDistance += SAMPLE.logDistance * weight;
    heading += SAMPLE.heading * weight;
    total += weight;
  }
  const lookAt: [number, number, number] = [x / total, y / total, z / total];
  const distance = Math.exp(logDistance / total);
  // Higher as the camera pulls out: a long move climbs, a close-up comes down to street level.
  const lift = Math.max(0, Math.min(1, Math.log(distance / MIN_DISTANCE) / Math.log(6)));
  const elevation = LOW_ELEVATION + (HIGH_ELEVATION - LOW_ELEVATION) * smooth(lift);
  const azimuth = Math.PI / 4 + (heading / total) * (Math.PI / 180);
  const flat = distance * Math.cos(elevation);
  return {
    lookAt,
    position: [
      lookAt[0] + flat * Math.sin(azimuth),
      lookAt[1] + distance * Math.sin(elevation),
      lookAt[2] + flat * Math.cos(azimuth),
    ],
  };
}
