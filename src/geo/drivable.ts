import { TERRAIN } from "../domain/nodeStyle";
import { distToSegment } from "../layout/geometry";
import type { RoadClass, RoadNetwork, Roundabout, Vec2 } from "../layout/types";
import { capLaneOffsets, MAX_TURN } from "./path";
import { closedSeam, roundCornersTagged } from "./polyline";
import { type Lanes, laneOffsets, ringRadii } from "./roadStyle";
import { driveAroundRoundabouts, roundaboutArcAt, roundaboutAround } from "./roundabouts";

/**
 * Turns a lattice route into the path a vehicle actually drives — the one
 * place where streets, roundabouts and bridges are joined up.
 *
 * `buildRoadNetwork` describes a route by its junction *centres*. Driven
 * literally that is wrong twice over: a roundabout is circled, not crossed
 * (`driveAroundRoundabouts`), and a bridge deck cannot start in the middle of
 * the roundabout it lands on. So a bridgehead roundabout treats the deck as
 * one more of its legs: the vehicle circles the ring from its feeder to the
 * deck's bearing, drives off the ring, and the deck begins at the ring's outer
 * edge (`bridgeDeck`). The mesh and the traffic both take the deck from here,
 * which is what keeps the vehicles on the tarmac at the ramp.
 *
 * Every match is by exact coordinate equality — the invariant the layout
 * already guarantees between route points, roundabout centres and bridgeheads.
 * Only *after* those matches are made is the path made pretty: lattice corners
 * become tangent arcs (`BEND_RADIUS`) and every step learns which lane offsets
 * its road class allows (`Lanes`), so the vehicles neither drift sideways in a
 * turn nor ride a boulevard as if it were a lane. Each step also says whether it
 * circulates on a roundabout (`ring`), which is what gives it priority over the
 * traffic entering (`sim/traffic/sim.ts`).
 */

export type Vec3 = [number, number, number];

export type { Lanes };
export { laneOffsets };

/** A drivable path: elevated points and, per segment, the lanes it offers. */
export interface DrivePath {
  junctions?: Roundabout[];
  points: Vec3[];
  /** `points.length - 1` entries. */
  lanes: Lanes[];
  /** `points.length - 1` entries: the step runs on a roundabout's circulating arc. */
  ring: boolean[];
}

/**
 * Samples of the arch over the water. The profile now has all its slope in the
 * middle rather than at the ends (see `deckHeight`), so it needs more of them:
 * the pitch change between two samples is what a vehicle swallows in one step.
 */
const SPAN_SEGMENTS = 32;
/**
 * The deck rides slightly above the streets even on land: at exactly `roadY` it
 * would be coplanar with every road it crosses and the two would z-fight.
 */
const LAND_LIFT = 0.02;
/**
 * Radius of the arc a vehicle takes at a lattice corner. Smaller than the
 * `BEND_RADIUS` the road itself is drawn with, so a right turn at a junction,
 * ridden in the right-hand lane, still clears the kerb's fillet.
 */
const BEND_RADIUS = 1.2;
const BEND_STEP = 0.3;
/** How close a step's midpoint must sit to a drawn edge to be driving on it. */
const ON_EDGE = 0.05;
/**
 * A ring vertex this close to a roundabout's tarmac is not a place to start a
 * loop: the entry blend of `roundabouts.ts` reaches ≈ 0.1 past `outer`, and the
 * first and last point of a loop must be plain ring vertices.
 */
const LOOP_CLEAR = 0.5;
/** A plain bridge is as wide as an avenue; upgrading it makes it a boulevard. */
export const DECK_CLASS: RoadClass = "avenue";
export const UPGRADED_DECK_CLASS: RoadClass = "boulevard";
/** The class a deck is drawn and driven at, from whether its bridge was upgraded. */
export function deckClass(upgraded: boolean | undefined): RoadClass {
  return upgraded ? UPGRADED_DECK_CLASS : DECK_CLASS;
}

function same(a: Vec2, b: Vec2): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

function ringAt(p: Vec2, roundabouts: Roundabout[]): Roundabout | undefined {
  return roundabouts.find((r) => same(r.center, p));
}

const DRIVEWAY_LANES: Lanes = [TERRAIN.drivewayWidth / 4, TERRAIN.drivewayWidth / 4];

/**
 * Height of the deck over the water at `u ∈ [0, 1]` along the span.
 *
 * `sin²`, not `sin`: a half-sine leaves the shore at its steepest, while the
 * road it comes off is flat. That break of slope is a real kink in the driven
 * path, a vehicle pitching between two samples, and it is the same break the
 * deck mesh shows. `sin²` starts and ends level, so the ramp grows out of the
 * road instead of jumping off it; the crown, and so the clearance over the
 * water, is unchanged, and the steepest slope is the same, only moved to the
 * middle of the span where there is nothing to disagree with.
 *
 * A bridge that grows does *not* gain a second level: it widens (see
 * `deckClass`), so there is only ever one deck at one height over a span.
 */
export function deckHeight(u: number): number {
  const s = Math.sin(Math.PI * u);
  return TERRAIN.roadY + LAND_LIFT + TERRAIN.bridgeMaxRise * s * s;
}

/**
 * Where the deck actually starts and ends: the two bridgehead corners pushed
 * out along the deck by the outer radius of the roundabout sitting on each,
 * so the ramp butts against the ring instead of covering it. A bridgehead
 * without a roundabout keeps the corner itself.
 */
export function bridgeDeck(bridgeheads: [Vec2, Vec2], roundabouts: Roundabout[]): [Vec2, Vec2] {
  const [a, b] = bridgeheads;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / length;
  const uz = (b[1] - a[1]) / length;
  const ra = ringAt(a, roundabouts);
  const rb = ringAt(b, roundabouts);
  const outA = ra ? ringRadii(ra).outer : 0;
  const outB = rb ? ringRadii(rb).outer : 0;
  return [
    [a[0] + ux * outA, a[1] + uz * outA],
    [b[0] - ux * outB, b[1] - uz * outB],
  ];
}

/**
 * The exact centreline of a bridge crossing: flat at the deck's land height,
 * lifted by a `sin(π·u)` arch over the one segment that *is* `span` (sampled,
 * so vehicles follow the same curve the deck is built from). A path whose span
 * is not one of its own segments stays flat — defensive, never expected.
 */
export function bridgeElevation(path: Vec2[], span: [Vec2, Vec2]): Vec3[] {
  const first = path[0];
  if (!first) {
    return [];
  }

  const landY = TERRAIN.roadY + LAND_LIFT;
  const out: Vec3[] = [[first[0], landY, first[1]]];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (same(a, span[0]) && same(b, span[1])) {
      for (let s = 1; s <= SPAN_SEGMENTS; s++) {
        const u = s / SPAN_SEGMENTS;
        out.push([a[0] + (b[0] - a[0]) * u, deckHeight(u), a[1] + (b[1] - a[1]) * u]);
      }
    } else {
      out.push([b[0], landY, b[1]]);
    }
  }
  return out;
}

/** Builds drivable paths over a set of road networks (one city, or every city a bridge can reach). */
export interface Driver {
  /** An intra-city route: round its roundabouts, corners rounded, flat on the asphalt. */
  street(points: Vec2[]): DrivePath;
  /**
   * The ring road as a closed loop, one way round (`reverse` for the other),
   * starting on a vertex clear of any roundabout so the first and last point —
   * which `driveAroundRoundabouts` never touches — are plain ring vertices.
   * `null` for a degenerate ring.
   */
  loop(ring: Vec2[], reverse: boolean): DrivePath | null;
  /**
   * An inter-city crossing: feeder streets, the bridgehead roundabouts circled
   * up to the deck's bearing, and the arch between the deck ends. `bridgeheads`
   * is the pair of corners in the direction of travel, as in `BridgeCrossing`.
   * `klass` is the width of the deck: an upgraded bridge is a boulevard, whose
   * two lanes each way sit *beside* the original ones, not above them.
   */
  crossing(points: Vec2[], bridgeheads: [Vec2, Vec2], klass?: RoadClass): DrivePath;
}

interface Edge {
  a: Vec2;
  b: Vec2;
  lanes: Lanes;
}

export function makeDriver(networks: RoadNetwork[]): Driver {
  const roundabouts = networks.flatMap((n) => n.roundabouts);
  const edges: Edge[] = [];
  for (const n of networks) {
    for (const s of n.segments) {
      const lanes = laneOffsets(s.klass);
      for (let i = 0; i + 1 < s.points.length; i++) {
        edges.push({ a: s.points[i]!, b: s.points[i + 1]!, lanes });
      }
    }
    for (const d of n.driveways) {
      edges.push({ a: d.mouth, b: d.door, lanes: DRIVEWAY_LANES });
    }
  }
  const fallback = laneOffsets("street");

  /** Which roundabout `p` belongs to (arc *or* entry blend), if any. */
  const within = (p: Vec2): Roundabout | undefined => roundaboutAround(p, roundabouts);

  /** Lanes of one step of a path that has already had its roundabouts circled. */
  const lanesOf = (a: Vec2, b: Vec2): Lanes => {
    const ra = within(a);
    if (ra && within(b) === ra) {
      return laneOffsets(ra.klass);
    }
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const e of edges) {
      if (distToSegment(mid, e.a, e.b) < ON_EDGE) {
        return e.lanes;
      }
    }
    return fallback;
  };

  /**
   * Roundabouts circled, lanes assigned, then lattice corners rounded — arc
   * points and `pinned` points (deck ends) keep their exact position. Inside a
   * rounded corner the incoming lanes hold until the middle of the arc.
   */
  const shape = (
    points: Vec2[],
    pinned: Vec2[],
    loop = false,
  ): { points: Vec2[]; lanes: Lanes[]; ring: boolean[] } => {
    const arced = driveAroundRoundabouts(points, roundabouts, pinned);
    const stepLanes: Lanes[] = [];
    for (let i = 0; i + 1 < arced.length; i++) {
      stepLanes.push(lanesOf(arced[i]!, arced[i + 1]!));
    }
    const keep = (p: Vec2) => !within(p) && !pinned.some((q) => same(p, q));
    const rounded = roundCornersTagged(arced, BEND_RADIUS, BEND_STEP, keep, MAX_TURN);
    const lanes: Lanes[] = [];
    const ring: boolean[] = [];
    for (let k = 0; k + 1 < rounded.points.length; k++) {
      const a = rounded.points[k]!;
      const b = rounded.points[k + 1]!;
      const arcA = roundaboutArcAt(a, roundabouts);
      ring.push(arcA !== undefined && roundaboutArcAt(b, roundabouts) === arcA);
      const from = rounded.origin[k]!;
      const to = rounded.origin[k + 1]!;
      if (from !== to) {
        lanes.push(stepLanes[from] ?? fallback);
        continue;
      }
      let start = k;
      while (start > 0 && rounded.origin[start - 1] === from) {
        start--;
      }
      let end = k;
      while (end + 2 < rounded.origin.length && rounded.origin[end + 2] === from) {
        end++;
      }
      const incoming = k - start < end - k;
      lanes.push(stepLanes[incoming ? from - 1 : from] ?? stepLanes[from] ?? fallback);
    }
    // Last line of defence: whatever produced a step, no lane may be asked to
    // ride a radius tighter than itself — that is the fold that made a vehicle
    // in the outer lane of a roundabout appear to reverse.
    return { points: rounded.points, lanes: capLaneOffsets(rounded.points, lanes, loop), ring };
  };

  const flat = (shaped: { points: Vec2[]; lanes: Lanes[]; ring: boolean[] }): DrivePath => ({
    points: shaped.points.map(([x, z]) => [x, TERRAIN.roadY, z]),
    lanes: shaped.lanes,
    ring: shaped.ring,
    junctions: roundabouts,
  });

  return {
    street: (points) => flat(shape(points, [])),

    loop: (ring, reverse) => {
      if (ring.length < 3) {
        return null;
      }
      const clear = (p: Vec2) =>
        roundabouts.every(
          (r) =>
            Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) > ringRadii(r).outer + LOOP_CLEAR,
        );
      // The seam sits mid-edge, so both ends are collinear with their
      // neighbours and every real vertex is interior — the closing corner is
      // rounded like any other instead of staying a sharp flick. Both the
      // vertex it starts on and the seam itself must be clear of the tarmac.
      const oriented = reverse ? [ring[0]!, ...ring.slice(1).reverse()] : ring;
      const n = oriented.length;
      const seam = (i: number): Vec2 => {
        const a = oriented[(i - 1 + n) % n]!;
        const b = oriented[i]!;
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      };
      let from = -1;
      for (let i = 0; i < n; i++) {
        if (clear(oriented[i]!) && clear(seam(i))) {
          from = i;
          break;
        }
      }
      if (from < 0) {
        from = oriented.findIndex(clear);
      }
      if (from < 0) {
        return null;
      }
      return flat(shape(closedSeam(oriented, from), [], true));
    },

    crossing: (points, bridgeheads, klass = DECK_CLASS) => {
      const deck = bridgeDeck(bridgeheads, roundabouts);
      // The deck ends go in right after the first bridgehead and right before the
      // second, so each roundabout arc exits (or enters) along the deck and the
      // arch spans exactly the two of them.
      const spliced: Vec2[] = [];
      for (const p of points) {
        if (same(p, bridgeheads[1]) && !same(deck[1], p)) {
          spliced.push(deck[1]);
        }
        spliced.push(p);
        if (same(p, bridgeheads[0]) && !same(deck[0], p)) {
          spliced.push(deck[0]);
        }
      }
      const shaped = shape(spliced, [deck[0], deck[1]]);
      // The arch is sampled into SPAN_SEGMENTS steps; its lanes are the deck's own class.
      const lanes: Lanes[] = [];
      const ring: boolean[] = [];
      const deckLanes = laneOffsets(klass);
      for (let i = 0; i + 1 < shaped.points.length; i++) {
        if (same(shaped.points[i]!, deck[0]) && same(shaped.points[i + 1]!, deck[1])) {
          for (let s = 0; s < SPAN_SEGMENTS; s++) {
            lanes.push(deckLanes);
            ring.push(false);
          }
        } else {
          lanes.push(shaped.lanes[i]!);
          ring.push(shaped.ring[i]!);
        }
      }
      return {
        points: bridgeElevation(shaped.points, deck),
        lanes,
        ring,
        junctions: roundabouts,
      };
    },
  };
}
