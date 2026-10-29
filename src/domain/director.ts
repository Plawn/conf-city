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
}

function frame(box: Box | null): Omit<ShotKey, "t"> | null {
  if (!box) {
    return null;
  }
  const span = Math.max(box.maxX - box.minX, box.maxZ - box.minZ, 4);
  return {
    lookAt: [(box.minX + box.maxX) / 2, 0, (box.minZ + box.maxZ) / 2],
    distance: Math.max(MIN_DISTANCE, (span + 10) * 1.05),
  };
}

function grow(box: Box | null, minX: number, maxX: number, minZ: number, maxZ: number): Box {
  return box
    ? {
        minX: Math.min(box.minX, minX),
        maxX: Math.max(box.maxX, maxX),
        minZ: Math.min(box.minZ, minZ),
        maxZ: Math.max(box.maxZ, maxZ),
      }
    : { minX, maxX, minZ, maxZ };
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
        box = grow(box, n.position[0] - 3, n.position[0] + 3, n.position[2] - 3, n.position[2] + 3);
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
  for (const e of tl.events) {
    if (e.at >= outroAt) {
      continue;
    }
    const current = clusters[clusters.length - 1];
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
      clusters.push([e]);
    }
  }
  clusters.forEach((cluster, i) => {
    const start = cluster[0]!.at;
    const end = cluster[cluster.length - 1]!.at + tl.rampSec + HOLD;
    add(start - LEAD, clusterFrame(tl, layout, cluster));
    if (cluster[0]!.kind === "remove") {
      holdUntil = cluster[cluster.length - 1]!.at + BLAST_HOLD;
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
