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
/** A quiet stretch longer than this gets a wide shot. */
const WIDE_GAP = 5;
/** A demolition shot holds until the fireball has died down. */
const BLAST_HOLD = 1.6;
/** Seconds a short camera move takes; a long one stretches up to `MAX_TRANSITION`. */
export const TRANSITION = 1.6;
const MAX_TRANSITION = 3.4;
/** Zoom-out during a long move (van Wijk & Nuij `rho`): higher climbs more. */
const RHO = 1.3;
const ORBIT_DEG_PER_SEC = 3;
/** Close-ups look across the street, wide shots look down from higher. */
const LOW_ELEVATION = (26 * Math.PI) / 180;
const HIGH_ELEVATION = (40 * Math.PI) / 180;
const MIN_DISTANCE = 14;
/** A held shot slowly pushes in by up to this fraction. */
const DRIFT = 0.08;
const DRIFT_SEC = 6;
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

/** The cloud and the nearest mast of its cable car, so the line it strings is in the frame. */
function cloudFrame(layout: WorldLayout, cityId: string) {
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
    box = grow(box, mast[0] - 1, mast[0] + 1, mast[1] - 1, mast[1] + 1, MAST_HEIGHT);
  }
  return frame(box);
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

/** Framings for the whole replay; `layout` is the union, laid out once. */
export function planShots(tl: Timeline, layout: WorldLayout): ShotKey[] {
  const intro = tl.scenario.introSec ?? 3;
  const outroAt = tl.totalSec - (tl.scenario.outroSec ?? 4);
  const wideAt = (t: number) => {
    const alive = aliveAt(tl, t);
    return frame(citiesBox(layout, alive.length > 0 ? alive : tl.cities.keys()));
  };
  const keys: ShotKey[] = [];
  let holdUntil = 0;
  /** A move toward `f` meant to land `TRANSITION` after `t`: a long one leaves earlier. */
  const add = (t: number, f: Framing | null) => {
    if (!f) {
      return;
    }
    const last = keys[keys.length - 1];
    if (!last) {
      keys.push({ t, ...f, duration: TRANSITION });
      return;
    }
    const duration = moveDuration(last, f);
    // Never start a move before the previous one has landed, nor cut a demolition short.
    const at = Math.max(t + TRANSITION - duration, last.t + last.duration, holdUntil);
    keys.push({ t: at, ...f, duration });
  };

  const opening = wideAt(intro);
  if (opening) {
    add(0, { ...opening, distance: opening.distance * 1.5 });
  }

  const clusters: TimelineEvent[][] = [];
  /** Open shot per cloud service: its buildings join it even when the islands keep busy meanwhile. */
  const skies = new Map<string, TimelineEvent[]>();
  let current: TimelineEvent[] | undefined;
  for (const e of tl.events) {
    if (e.at >= outroAt) {
      continue;
    }
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
    // Demolitions get their own shot: never merged with what is being built.
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
  clusters.forEach((cluster, i) => {
    const start = cluster[0]!.at;
    const last = cluster[cluster.length - 1]!.at;
    const end = last + tl.rampSec + HOLD;
    const sky = cloudArrival(layout, cluster[0]!);
    add(
      start - LEAD,
      sky ? cloudFrame(layout, cluster[0]!.cityId) : clusterFrame(tl, layout, cluster),
    );
    if (cluster[0]!.kind === "remove") {
      holdUntil = last + BLAST_HOLD;
    } else if (sky) {
      // Stay until it has landed and its buildings are up.
      holdUntil = end;
    }
    const next = clusters[i + 1]?.[0]?.at ?? outroAt;
    if (next - end > WIDE_GAP) {
      add(end, wideAt(end));
    }
  });

  add(outroAt, wideAt(outroAt));
  return keys;
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

interface RawPose {
  x: number;
  y: number;
  z: number;
  logDistance: number;
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
}

const SAMPLE: RawPose = { x: 0, y: 0, z: 0, logDistance: 0 };

/** Pose at video second `t`: the zoom path averaged over a short window, slowly orbiting. */
export function shotAt(keys: ShotKey[], t: number): CameraPose | null {
  if (keys.length === 0) {
    return null;
  }
  let x = 0;
  let y = 0;
  let z = 0;
  let logDistance = 0;
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
    total += weight;
  }
  const lookAt: [number, number, number] = [x / total, y / total, z / total];
  const distance = Math.exp(logDistance / total);
  // Higher as the camera pulls out: a long move climbs, a close-up comes down to street level.
  const lift = Math.max(0, Math.min(1, Math.log(distance / MIN_DISTANCE) / Math.log(6)));
  const elevation = LOW_ELEVATION + (HIGH_ELEVATION - LOW_ELEVATION) * smooth(lift);
  const azimuth = Math.PI / 4 + (t * ORBIT_DEG_PER_SEC * Math.PI) / 180;
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
