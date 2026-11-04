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
/** Seconds a camera move takes. */
export const TRANSITION = 1.6;
const ORBIT_DEG_PER_SEC = 3;
const ELEVATION = (35 * Math.PI) / 180;
const MIN_DISTANCE = 14;

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Altitude range: sea level, or a cloud service's deck. */
  minY: number;
  maxY: number;
}

function frame(box: Box | null): Omit<ShotKey, "t"> | null {
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

/** Close-up on a handful of buildings of one island, else the islands involved. */
function clusterFrame(tl: Timeline, layout: WorldLayout, events: TimelineEvent[]) {
  const cityIds = new Set(events.map((e) => e.cityId));
  const addrs = events.filter((e) => e.what === "node").map((e) => e.id);
  if (
    cityIds.size === 1 &&
    addrs.length > 0 &&
    addrs.length <= 3 &&
    events.every((e) => e.what !== "city")
  ) {
    let box: Box | null = null;
    for (const n of layout.nodes) {
      if (addrs.includes(`${n.cityId}/${n.id}`)) {
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
  const add = (t: number, f: Omit<ShotKey, "t"> | null) => {
    if (!f) {
      return;
    }
    const last = keys[keys.length - 1];
    // Never start a move before the previous one has landed, nor cut a demolition short.
    const at = last ? Math.max(t, last.t + TRANSITION, holdUntil) : t;
    keys.push({ t: at, ...f });
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

/** Pose at video second `t`: eased between framings, slowly orbiting throughout. */
export function shotAt(keys: ShotKey[], t: number): CameraPose | null {
  if (keys.length === 0) {
    return null;
  }
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.t <= t) {
    i++;
  }
  const to = keys[i]!;
  const from = keys[i - 1] ?? to;
  const e = t < to.t ? 0 : smooth((t - to.t) / TRANSITION);
  const start = t < to.t ? to : from;
  const lerp = (a: number, b: number) => a + (b - a) * e;
  const lookAt: [number, number, number] = [
    lerp(start.lookAt[0], to.lookAt[0]),
    lerp(start.lookAt[1], to.lookAt[1]),
    lerp(start.lookAt[2], to.lookAt[2]),
  ];
  const distance = Math.exp(lerp(Math.log(start.distance), Math.log(to.distance)));
  const azimuth = Math.PI / 4 + (t * ORBIT_DEG_PER_SEC * Math.PI) / 180;
  const flat = distance * Math.cos(ELEVATION);
  return {
    lookAt,
    position: [
      lookAt[0] + flat * Math.sin(azimuth),
      lookAt[1] + distance * Math.sin(ELEVATION),
      lookAt[2] + flat * Math.cos(azimuth),
    ],
  };
}
