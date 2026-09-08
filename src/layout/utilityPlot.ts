import { clipSegmentToPolygon, signedArea } from "./geometry";
import { distanceToPolygon } from "./harbour";
import { fnv1a, mulberry32 } from "./random";
import type { RoadNetwork, UtilityPlot, UtilitySlot, Vec2 } from "./types";

/**
 * Where a city puts its machine gauges: the **utility district**, one plot per
 * island, on the seafront outside the ring road.
 *
 * The lighthouse (and, on the same plot, the power station, the water tower and
 * the container quay) are not services — they are the box itself. So they get
 * the one stretch of land no building ever asks for: the strip the ring road
 * leaves between itself and the water. That strip is barely two units deep
 * where the coast runs parallel to the ring, but `roughen` (`outline.ts`) only
 * ever pushes the shore *outward*, so every island has headlands where it is
 * wider. Picking the widest one is what this file does: the district ends up on
 * the island's promontory, which is exactly where a real one would be.
 *
 * A plot is therefore a **stretch of coast**, not a square: `shoreward` says
 * where the water is, `room` how deep the buildable band is, and the district
 * is laid out along the tangent, the way a waterfront is. The plot carries the
 * `slots` that waterfront is cut into — one per installation, in a fixed order,
 * so the renderer never does placement of its own. A cramped island gets the
 * same four slots, closer together, and a `scale` under 1 saying so.
 *
 * Bridgeheads are what the plot is pushed away from: a roundabout on the ring
 * is the busiest corner of the island, and the deck already claims the eye
 * there.
 *
 * Pure and deterministic, like every other layout step: the same city puts its
 * lighthouse on the same rock on every reload and on every client.
 */

/**
 * How many installations the district holds: the lighthouse, the power station,
 * the water tower and the container quay, in that order along the shore.
 */
export const SLOT_COUNT = 4;
/** Room one installation wants along the shore. Less than this and it shrinks. */
const SLOT_SPACING = 3.4;
/** Coast the district asks for. A longer headland is not worth more than this. */
const DISTRICT_LENGTH = SLOT_COUNT * SLOT_SPACING;
/** Depth an installation wants, from the ring's kerb out to the water. */
const SLOT_DEPTH = 2.2;
/** How far it may lean out over the beach — a quay does, a house would not. */
const BEACH_OVERHANG = 0.6;
/** Radius the vegetation scatter keeps clear around each slot. */
export const PLOT_RADIUS = 2.6;
/** Step the ring is walked at. Finer than its vertices: headlands are short. */
const SAMPLE_STEP = 0.8;
/** Half an avenue plus its pavement plus a margin: the ring's tarmac, kerb included. */
const RING_CLEAR = 1.45;
/** Nothing is built on the beach the island's bevel is cut into. */
const SHORE_MARGIN = 0.35;
/** Any other road (a feeder, a driveway to the ring) is given a full clearance. */
const ROAD_CLEAR = 2.2;
/** Past this a bridgehead is simply "far" — one distant deck must not rank the coast. */
const GATE_REACH = 24;
/** Nothing of the district lands on a building — the port's berths included. */
const BUILDING_CLEAR = 3;
/** How far the ray looking for the shore is cast: past any plausible coast. */
const SHORE_REACH = 40;

export interface UtilityPlotRequest {
  cityId: string;
  /** Local coordinates, as everywhere in `buildLocalCity`. */
  outline: Vec2[];
  /** The ring road, after the bridgeheads and the driveways have attached to it. */
  ring: Vec2[];
  /** The city's streets, so the plot never lands on tarmac. */
  roads: RoadNetwork;
  /** Buildings already standing, `[x, z]` — including the berths of the port. */
  buildings: readonly Vec2[];
  /** Bridgeheads on this island's ring, in local coordinates. */
  gates: readonly Vec2[];
}

interface Sample {
  /** Middle of the band, where an installation would stand. */
  center: Vec2;
  shoreward: Vec2;
  room: number;
  /** Distance to the nearest bridgehead, capped at `GATE_REACH`. */
  gate: number;
  /** False when the spot is already taken: a run of samples stops here. */
  ok: boolean;
}

/**
 * Picks the district's waterfront, or returns `null` when the island has no
 * coast to put one on — a ring too small to walk, or a shore the ring touches.
 */
export function placeUtilityPlot(req: UtilityPlotRequest): UtilityPlot | null {
  if (req.outline.length < 3 || req.ring.length < 3) {
    return null;
  }
  const rand = mulberry32(fnv1a(`utilities:${req.cityId}`));
  // The salt is drawn per window, in the order the ring is walked, so it only
  // ever separates two headlands the score already ties.
  let best: Sample[] | null = null;
  let bestScore = -Infinity;
  for (const run of buildableRuns(walkRing(req))) {
    const t = runLengths(run);
    for (let i = 0; i < run.length; i++) {
      let j = i;
      while (j + 1 < run.length && t[j + 1]! - t[i]! <= DISTRICT_LENGTH) {
        j++;
      }
      const window = run.slice(i, j + 1);
      const score = windowScore(window, t[j]! - t[i]!) + rand() * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = window;
      }
    }
  }
  return best ? district(best) : null;
}

/** Moves a plot from local to world coordinates. */
export function translateUtilityPlot(plot: UtilityPlot, dx: number, dz: number): UtilityPlot {
  return {
    ...plot,
    center: [plot.center[0] + dx, plot.center[1] + dz],
    slots: plot.slots.map((sl) => ({ ...sl, center: [sl.center[0] + dx, sl.center[1] + dz] })),
  };
}

/**
 * How good a stretch of coast is for the district: deep land, far from the
 * decks, and long enough to line the four installations up along the water.
 *
 * Depth is what the eye reads — a shallow district is a row of models with
 * their backs against the kerb — so it weighs most; length only has to reach
 * `DISTRICT_LENGTH`, past which a longer waterfront is worth nothing more.
 */
function windowScore(window: Sample[], span: number): number {
  let room = 0;
  let gate = GATE_REACH;
  for (const x of window) {
    room += x.room;
    gate = Math.min(gate, x.gate);
  }
  return (
    (room / window.length) * 6 + (gate / GATE_REACH) * 3 + Math.min(1, span / DISTRICT_LENGTH) * 3
  );
}

/**
 * Cuts the waterfront into its slots: `SLOT_COUNT` of them, evenly spread, each
 * on a sample the walk already validated — no point is invented here. A stretch
 * shorter than the district wants is not refused, it is built tighter: `scale`
 * is what the renderer shrinks its models by.
 */
function district(run: Sample[]): UtilityPlot {
  const t = runLengths(run);
  const span = t.at(-1)!;
  const step = span / SLOT_COUNT;
  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    slots.push(slotAt(run, t, (i + 0.5) * step));
  }
  const mid = slotAt(run, t, span / 2);
  // What the land actually allows, on both axes: how close the neighbours are
  // along the shore, and how deep the band is. The band is the binding one —
  // between the ring's kerb and the beach there are often barely two units, and
  // a model may only lean out over the sand, never in over the tarmac.
  const depth = slots.reduce((a, sl) => a + sl.room, 0) / slots.length + BEACH_OVERHANG;
  return {
    center: mid.center,
    yaw: mid.yaw,
    shoreward: mid.shoreward,
    room: mid.room,
    span,
    scale: Math.min(1, step / SLOT_SPACING, depth / SLOT_DEPTH),
    slots,
  };
}

/** The sample nearest a distance along the run, as a slot facing the sea. */
function slotAt(run: Sample[], t: number[], at: number): UtilitySlot {
  let best = 0;
  for (let i = 1; i < run.length; i++) {
    if (Math.abs(t[i]! - at) < Math.abs(t[best]! - at)) {
      best = i;
    }
  }
  const x = run[best]!;
  return {
    center: x.center,
    // A model faces −Z; this yaw turns that face toward the open sea, the same
    // convention the berths of `harbour.ts` use.
    yaw: Math.atan2(-x.shoreward[0], -x.shoreward[1]),
    shoreward: x.shoreward,
    room: x.room,
  };
}

/** Distance of every sample of a run from its first, along the shore. */
function runLengths(run: Sample[]): number[] {
  const t = [0];
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1]!.center;
    const b = run[i]!.center;
    t.push(t[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return t;
}

/**
 * Walks the ring road at a fixed step — finer than its vertices, because a
 * headland is often a single edge — and probes the seaward side of each point.
 */
function walkRing(req: UtilityPlotRequest): Sample[] {
  const ring = req.ring;
  const outward = signedArea(ring) >= 0 ? 1 : -1;
  const out: Sample[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) {
      continue;
    }
    // Outward normal of a CCW polygon in (x, z): (dz, −dx).
    const n: Vec2 = [(dz / len) * outward, (-dx / len) * outward];
    const steps = Math.max(1, Math.round(len / SAMPLE_STEP));
    for (let k = 0; k < steps; k++) {
      const f = (k + 0.5) / steps;
      out.push(probe([a[0] + dx * f, a[1] + dz * f], n, req));
    }
  }
  return out;
}

/**
 * The band of land between the ring's kerb and the beach, straight out to sea
 * from one point of the ring — or a dead sample when there is none to build on.
 */
function probe(on: Vec2, n: Vec2, req: UtilityPlotRequest): Sample {
  const dead: Sample = { center: on, shoreward: n, room: 0, gate: 0, ok: false };
  const shore = clipSegmentToPolygon(
    on,
    [on[0] + n[0] * SHORE_REACH, on[1] + n[1] * SHORE_REACH],
    req.outline,
  );
  if (!shore) {
    return dead;
  }
  const room = Math.hypot(shore[0] - on[0], shore[1] - on[1]) - RING_CLEAR - SHORE_MARGIN;
  if (room <= 0) {
    return dead;
  }
  const inset = RING_CLEAR + room / 2;
  const center: Vec2 = [on[0] + n[0] * inset, on[1] + n[1] * inset];
  if (!buildable(center, req)) {
    return dead;
  }
  let gate = GATE_REACH;
  for (const g of req.gates) {
    gate = Math.min(gate, Math.hypot(center[0] - g[0], center[1] - g[1]));
  }
  return { center, shoreward: n, room, gate, ok: true };
}

/**
 * The stretches of coast that are free from end to end. The ring is a loop, so
 * the walk is rotated to start just after a taken spot before being cut up —
 * otherwise a district straddling the first sample would be split in two.
 */
function buildableRuns(samples: Sample[]): Sample[][] {
  const n = samples.length;
  if (n === 0) {
    return [];
  }
  const start = samples.findIndex((x) => !x.ok);
  if (start === -1) {
    return [samples];
  }
  const runs: Sample[][] = [];
  let cur: Sample[] = [];
  for (let k = 1; k <= n; k++) {
    const x = samples[(start + k) % n]!;
    if (x.ok) {
      cur.push(x);
    } else if (cur.length > 0) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) {
    runs.push(cur);
  }
  return runs;
}

/** True when nothing already built stands on the point. */
function buildable(p: Vec2, req: UtilityPlotRequest): boolean {
  for (const b of req.buildings) {
    if (Math.hypot(p[0] - b[0], p[1] - b[1]) < BUILDING_CLEAR) {
      return false;
    }
  }
  for (const seg of req.roads.segments) {
    // The ring is what the band is measured from; only the streets that cross
    // out to it — a bridge feeder, a driveway — can be in the way.
    if (seg.ring) {
      continue;
    }
    if (distToPolyline(p, seg.points) < ROAD_CLEAR) {
      return false;
    }
  }
  for (const d of req.roads.driveways) {
    if (distToPolyline(p, [d.mouth, d.door]) < ROAD_CLEAR) {
      return false;
    }
  }
  for (const r of req.roads.roundabouts) {
    if (Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) < r.radius + ROAD_CLEAR) {
      return false;
    }
  }
  return distanceToPolygon(p, req.ring) >= RING_CLEAR - 1e-6;
}

function distToPolyline(p: Vec2, points: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const len2 = vx * vx + vz * vz;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vz * t)));
  }
  return best;
}
