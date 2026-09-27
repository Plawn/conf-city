import { vecKey } from "../../layout/geometry";
import type { RoadClass, RoadSegment, Roundabout, Vec2 } from "../../layout/types";
import { pointAt, projectOnPolyline, roundCorners } from "./polyline";
import { CLASS_STYLE } from "./roadStyle";

/**
 * The road network as the renderer sees it: long `Run`s meeting at `GraphNode`s.
 *
 * The layout hands over segments cut at every crossing, roundabout and class
 * change, with a lattice corner still a vertex wherever a street bends. Here the
 * pieces that merely continue one another (two arms, same class, no roundabout)
 * are fused back into one polyline and their bends rounded, so a turn is drawn
 * as a curve instead of two rectangles and a disc; dead ends are trimmed just
 * past their last driveway instead of running a whole block further; and every
 * remaining end becomes a node, keyed on the exact coordinates the layout
 * guarantees to match (roundabout centres, bridgeheads).
 *
 * A closed loop (a ring nothing attaches to) keeps its first point repeated at
 * the end, so it still has a node — a two-arm one, drawn as an invisible seam.
 */

export interface Run {
  points: Vec2[];
  klass: RoadClass;
  ring: boolean;
  halfWidth: number;
}

export interface Arm {
  /** Index in `runs`; `-1` for a virtual arm (a bridge deck leaving a roundabout). */
  run: number;
  atStart: boolean;
  /** Direction *away* from the node, in radians on the ground plane (`atan2(z, x)`). */
  bearing: number;
  halfWidth: number;
  klass: RoadClass;
}

export interface GraphNode {
  pos: Vec2;
  kind: "junction" | "roundabout" | "end";
  arms: Arm[];
  roundabout?: Roundabout;
}

export interface RoadGraph {
  runs: Run[];
  nodes: GraphNode[];
  /** Node at each end of each run, same index as `runs`. */
  ends: { start: GraphNode; end: GraphNode }[];
}

/** An exit that is not a run: the bridge deck leaving a bridgehead roundabout. */
export interface DeckExit {
  at: Vec2;
  toward: Vec2;
  halfWidth: number;
}

/** How far a dead end runs past its last driveway mouth. */
const END_OVERHANG = 0.9;
/** Radius of the curve replacing a lattice bend. */
const BEND_RADIUS = 1.5;
/** Distance under which a point counts as lying on a centreline. */
export const ON_LINE = 0.01;

function bearingOf(from: Vec2, to: Vec2): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0]);
}

interface Piece {
  points: Vec2[];
  bend: boolean[];
  klass: RoadClass;
  ring: boolean;
}

/** Cuts a dead end back to `END_OVERHANG` past the last driveway mouth on its last step. */
function trimDeadEnds(
  segments: RoadSegment[],
  mouths: Vec2[],
  roundaboutKeys: Set<string>,
): Piece[] {
  const degree = new Map<string, number>();
  for (const s of segments) {
    for (const p of [s.points[0]!, s.points[s.points.length - 1]!]) {
      const k = vecKey(p);
      degree.set(k, (degree.get(k) ?? 0) + 1);
    }
  }
  const trim = (points: Vec2[]): Vec2[] => {
    const last = points[points.length - 1]!;
    if ((degree.get(vecKey(last)) ?? 0) !== 1 || roundaboutKeys.has(vecKey(last))) {
      return points;
    }
    const prev = points[points.length - 2]!;
    const step: Vec2[] = [prev, last];
    const length = Math.hypot(last[0] - prev[0], last[1] - prev[1]);
    let farthest = -1;
    for (const m of mouths) {
      const hit = projectOnPolyline(step, m);
      if (hit.dist < ON_LINE) {
        farthest = Math.max(farthest, hit.t);
      }
    }
    if (farthest < 0 || farthest + END_OVERHANG >= length - ON_LINE) {
      return points;
    }
    return [...points.slice(0, -1), pointAt(step, farthest + END_OVERHANG).point];
  };
  return segments.map((s) => {
    let points = trim(s.points);
    points = trim([...points].reverse()).reverse();
    return { points, bend: points.map(() => false), klass: s.klass, ring: s.ring === true };
  });
}

/** Joins pieces end to end through two-arm nodes of one class, marking the joins as bends. */
function fuse(pieces: Piece[], roundaboutKeys: Set<string>): Piece[] {
  const at = new Map<string, { piece: number; atStart: boolean }[]>();
  pieces.forEach((p, i) => {
    for (const [point, atStart] of [
      [p.points[0]!, true],
      [p.points[p.points.length - 1]!, false],
    ] as const) {
      const k = vecKey(point);
      const list = at.get(k) ?? [];
      list.push({ piece: i, atStart });
      at.set(k, list);
    }
  });

  const consumed = new Set<number>();
  const out: Piece[] = [];
  const reverse = (p: Piece) => {
    p.points.reverse();
    p.bend.reverse();
  };
  /** Extends `acc` forward from its last point while the node there is a plain continuation. */
  const extend = (acc: Piece, startKey: string) => {
    for (;;) {
      const tail = acc.points[acc.points.length - 1]!;
      const k = vecKey(tail);
      if (k === startKey) {
        return; // closed the loop
      }
      if (roundaboutKeys.has(k)) {
        return;
      }
      const here = at.get(k) ?? [];
      if (here.length !== 2) {
        return;
      }
      const next = here.find((h) => !consumed.has(h.piece));
      if (!next) {
        return;
      }
      const piece = pieces[next.piece]!;
      if (piece.klass !== acc.klass) {
        return;
      }
      consumed.add(next.piece);
      const points = next.atStart ? piece.points : [...piece.points].reverse();
      const bend = next.atStart ? piece.bend : [...piece.bend].reverse();
      acc.bend[acc.bend.length - 1] = true;
      for (let i = 1; i < points.length; i++) {
        acc.points.push(points[i]!);
        acc.bend.push(bend[i]!);
      }
      acc.ring = acc.ring || piece.ring;
    }
  };

  for (let i = 0; i < pieces.length; i++) {
    if (consumed.has(i)) {
      continue;
    }
    consumed.add(i);
    const seed = pieces[i]!;
    const acc: Piece = {
      points: [...seed.points],
      bend: [...seed.bend],
      klass: seed.klass,
      ring: seed.ring,
    };
    extend(acc, vecKey(acc.points[0]!));
    reverse(acc);
    extend(acc, vecKey(acc.points[0]!));
    out.push(acc);
  }
  return out;
}

export function buildRoadGraph(
  segments: RoadSegment[],
  roundabouts: Roundabout[],
  mouths: Vec2[],
  exits: DeckExit[] = [],
): RoadGraph {
  const roundaboutAt = new Map<string, Roundabout>();
  for (const r of roundabouts) {
    roundaboutAt.set(vecKey(r.center), r);
  }
  const roundaboutKeys = new Set(roundaboutAt.keys());

  const pieces = fuse(trimDeadEnds(segments, mouths, roundaboutKeys), roundaboutKeys);
  const runs: Run[] = pieces.map((p) => {
    const bends = new Set<number>();
    p.bend.forEach((b, i) => {
      if (b) {
        bends.add(i);
      }
    });
    // Only the vertices where two lattice pieces met are bends; a ring already curves.
    const points =
      bends.size > 0 ? roundCorners(p.points, BEND_RADIUS, 0.3, (_, i) => bends.has(i)) : p.points;
    // `roundCorners` re-indexes: it keeps the ends, which is all the graph needs.
    return { points, klass: p.klass, ring: p.ring, halfWidth: CLASS_STYLE[p.klass].width / 2 };
  });

  const nodes = new Map<string, GraphNode>();
  const nodeFor = (p: Vec2): GraphNode => {
    const k = vecKey(p);
    let node = nodes.get(k);
    if (!node) {
      const roundabout = roundaboutAt.get(k);
      node = {
        pos: p,
        kind: roundabout ? "roundabout" : "end",
        arms: [],
        ...(roundabout ? { roundabout } : {}),
      };
      nodes.set(k, node);
    }
    return node;
  };
  const ends: RoadGraph["ends"] = [];
  runs.forEach((run, i) => {
    const n = run.points.length;
    const first = run.points[0]!;
    const last = run.points[n - 1]!;
    const start = nodeFor(first);
    const end = nodeFor(last);
    start.arms.push({
      run: i,
      atStart: true,
      bearing: bearingOf(first, run.points[1]!),
      halfWidth: run.halfWidth,
      klass: run.klass,
    });
    end.arms.push({
      run: i,
      atStart: false,
      bearing: bearingOf(last, run.points[n - 2]!),
      halfWidth: run.halfWidth,
      klass: run.klass,
    });
    ends.push({ start, end });
  });
  for (const exit of exits) {
    const node = nodes.get(vecKey(exit.at));
    if (!node) {
      continue;
    }
    node.arms.push({
      run: -1,
      atStart: true,
      bearing: bearingOf(exit.at, exit.toward),
      halfWidth: exit.halfWidth,
      klass: "avenue",
    });
  }
  for (const node of nodes.values()) {
    if (node.kind !== "roundabout") {
      node.kind = node.arms.length === 1 ? "end" : "junction";
    }
  }
  return { runs, nodes: [...nodes.values()], ends };
}
