import type { Vec2 } from "../layout/types";
import { TAU } from "../lib/math";
import { arcPoints, roundCorners } from "./polyline";
import type { GraphNode } from "./roadGraph";
import { ringRadii } from "./roadStyle";

/**
 * The shape of a node where roads meet: one closed asphalt outline, and a
 * pavement piece for every pair of neighbouring arms.
 *
 * Arms are sorted by bearing; between two neighbours the block corner is where
 * their two asphalt edges cross, rounded by a fillet tangent to both. When the
 * arms are nearly opposite (a bend, a class change, a seam) there is no corner
 * to round and the edge simply continues — and past that, when the wedge is
 * reflex (a dead end, a T seen from its open side) the edge sweeps around the
 * node instead. `reach[k]` says how far along arm `k` the piece extends, so the
 * caller can cut the run there and let the two meet on the same line.
 *
 * Roundabouts are simpler: every arm is cut square at the outer radius, two
 * aprons fill the corners between that cut and the circle, and the pavement is
 * the annulus outside it, following the arm's kerb down to the circle.
 */

export interface PavementPiece {
  /** Asphalt-side chain, then the block-side chain, both open and running the same way. */
  inner: Vec2[];
  outer: Vec2[];
}

export interface JunctionPieces {
  /** Closed asphalt outline (`null` for a roundabout: the ring covers it). */
  asphalt: Vec2[] | null;
  /** Roundabout only: the corners between each square arm cut and the ring, one per side. */
  aprons: { arm: number; points: Vec2[] }[];
  /** Roundabout only: the angles the ring is drawn at, one increasing turn; aprons share them. */
  ring: number[] | null;
  pavements: PavementPiece[];
  /** Cut distance along each of `node.arms`, same order. */
  reach: number[];
}

/** Below this angle short of a straight line, two arms are treated as one continuing road. */
const FLAT = 0.5;
const ARC_STEP = 0.12;
/** The kerb radius grows with the narrower road of a corner, up to this factor of `fillet`. */
const STREET_HALF = 0.5;
const FILLET_GROWTH = 1.5;
/** A kerb radius never shrinks below this. */
const MIN_FILLET = 0.15;
/** A straight class change ramps its width over this many units per unit of half-width change. */
const TAPER_PER_WIDTH = 8;
/** What the inner kerb of a class change round a bend keeps between itself and the bend's centre. */
const TAPER_KERB = 0.15;
/** Sharper turns than this (arms closer than 60°) keep the filleted corner. */
const MIN_TAPER_TURN = Math.PI / 3;

/** Longest chord of a roundabout's tarmac circle. */
const RING_STEP = 0.12;

type Pair =
  | { kind: "fillet"; centre: Vec2; radius: number; a0: number; a1: number; tk: number; tn: number }
  | { kind: "round"; radius: number; a0: number; a1: number };

/**
 * `limits[k]`, when given, is the longest arm `k` may be cut back: the fillet
 * shrinks so a short run between two crossings keeps some asphalt of its own.
 * `frame(k, t)` is where arm `k` really is `t` along its run (point, direction
 * away from the node): the cap's corners then meet a curved run's cut exactly.
 */
export function junctionPieces(
  node: GraphNode,
  pavement: number,
  fillet: number,
  limits?: number[],
  frame?: (arm: number, t: number) => { point: Vec2; dir: Vec2 } | null,
): JunctionPieces {
  const [px, pz] = node.pos;
  const order = node.arms
    .map((arm, index) => ({ arm, index }))
    .sort((a, b) => a.arm.bearing - b.arm.bearing);
  const n = order.length;
  const reach = node.arms.map(() => 0);
  if (n === 0) {
    return { asphalt: null, aprons: [], ring: null, pavements: [], reach };
  }

  const dir = (a: number): Vec2 => [Math.cos(a), Math.sin(a)];
  /** The two sides of an arm: `A` towards increasing bearing, `B` the other way. */
  const sideA = (a: number): Vec2 => [-Math.sin(a), Math.cos(a)];
  const sideB = (a: number): Vec2 => [Math.sin(a), -Math.cos(a)];
  const at = (base: Vec2, side: Vec2, h: number, u: Vec2, t: number): Vec2 => [
    base[0] + side[0] * h + u[0] * t,
    base[1] + side[1] * h + u[1] * t,
  ];

  if (node.kind === "roundabout" && node.roundabout) {
    return roundaboutPieces(node, order, pavement, reach, dir, sideA, sideB, at);
  }

  if (n === 2) {
    const taper = classTaper(node, order, pavement, reach, limits, frame);
    if (taper) {
      return taper;
    }
  }

  // Pass one: what happens between each pair of neighbouring arms, and how far
  // along each arm the pieces need to extend.
  const pairs: Pair[] = [];
  for (let k = 0; k < n; k++) {
    const here = order[k]!;
    const next = order[(k + 1) % n]!;
    const θk = here.arm.bearing;
    let θn = next.arm.bearing;
    if (n === 1) {
      θn = θk + TAU;
    } else {
      while (θn <= θk) {
        θn += TAU;
      }
    }
    const delta = θn - θk;
    const hk = here.arm.halfWidth;
    const hn = next.arm.halfWidth;
    let pair: Pair | null = null;
    if (delta < Math.PI - FLAT) {
      // Edge lines: arm k's A side and arm n's B side, both running outwards.
      const uk = dir(θk);
      const un = dir(θn);
      const w: Vec2 = [
        sideB(θn)[0] * hn - sideA(θk)[0] * hk,
        sideB(θn)[1] * hn - sideA(θk)[1] * hk,
      ];
      const cross = uk[0] * un[1] - uk[1] * un[0];
      const tk = (w[0] * un[1] - w[1] * un[0]) / cross;
      const tn = (w[0] * uk[1] - w[1] * uk[0]) / cross;
      if (tk > 0 && tn > 0) {
        // Wider roads get a wider kerb radius; a short run shrinks it back.
        const room = (k: number, t: number) =>
          ((limits?.[k] ?? Infinity) - t - 0.02) * Math.tan(delta / 2);
        const radius = Math.max(
          MIN_FILLET,
          Math.min(
            fillet * Math.min(FILLET_GROWTH, Math.min(hk, hn) / STREET_HALF),
            room(here.index, tk),
            room(next.index, tn),
          ),
        );
        const d = radius / Math.tan(delta / 2);
        const x = at(node.pos, sideA(θk), hk, uk, tk);
        const bis: Vec2 = [uk[0] + un[0], uk[1] + un[1]];
        const bl = Math.hypot(bis[0], bis[1]);
        const c = radius / Math.sin(delta / 2);
        const centre: Vec2 = [x[0] + (bis[0] / bl) * c, x[1] + (bis[1] / bl) * c];
        const t1: Vec2 = [x[0] + uk[0] * d, x[1] + uk[1] * d];
        const t2: Vec2 = [x[0] + un[0] * d, x[1] + un[1] * d];
        const a0 = Math.atan2(t1[1] - centre[1], t1[0] - centre[0]);
        let a1 = Math.atan2(t2[1] - centre[1], t2[0] - centre[0]);
        // The short way round: the fillet sweeps π − delta.
        while (a1 - a0 > Math.PI) {
          a1 -= TAU;
        }
        while (a1 - a0 < -Math.PI) {
          a1 += TAU;
        }
        pair = { kind: "fillet", centre, radius, a0, a1, tk: tk + d, tn: tn + d };
        reach[here.index] = Math.max(reach[here.index]!, tk + d);
        reach[next.index] = Math.max(reach[next.index]!, tn + d);
      }
    }
    if (!pair) {
      const radius = Math.max(hk, hn);
      pair = { kind: "round", radius, a0: θk + Math.PI / 2, a1: θn - Math.PI / 2 };
      reach[here.index] = Math.max(reach[here.index]!, radius);
      reach[next.index] = Math.max(reach[next.index]!, radius);
    }
    pairs.push(pair);
  }
  for (let i = 0; i < reach.length; i++) {
    reach[i]! += 0.02;
  }

  // Pass two: the chains, now that every arm knows its final cut.
  const asphalt: Vec2[] = [];
  const pavements: PavementPiece[] = [];
  for (let k = 0; k < n; k++) {
    const here = order[k]!;
    const next = order[(k + 1) % n]!;
    const pair = pairs[k]!;
    const θk = here.arm.bearing;
    const θn = next.arm.bearing;
    const rk = reach[here.index]!;
    const rn = reach[next.index]!;
    // A point `h` to side A (`+1`) or B (`-1`) of an arm's cut.
    const edge = (arm: number, θ: number, t: number, sign: number, h: number): Vec2 => {
      const f = frame?.(arm, t);
      if (!f) {
        return at(node.pos, sign > 0 ? sideA(θ) : sideB(θ), h, dir(θ), t);
      }
      return [f.point[0] - sign * f.dir[1] * h, f.point[1] + sign * f.dir[0] * h];
    };
    const hk = here.arm.halfWidth;
    const hn = next.arm.halfWidth;
    const lk = edge(here.index, θk, rk, 1, hk);
    const rkPoint = edge(here.index, θk, rk, -1, hk);
    const rnPoint = edge(next.index, θn, rn, -1, hn);
    const lkOut = edge(here.index, θk, rk, 1, hk + pavement);
    const rnOut = edge(next.index, θn, rn, -1, hn + pavement);

    let innerArc: Vec2[];
    let outerArc: Vec2[];
    if (pair.kind === "fillet") {
      innerArc = arcPoints(pair.centre, pair.radius, pair.a0, pair.a1, ARC_STEP);
      const back = pair.radius - pavement;
      outerArc =
        back > 0.03 ? arcPoints(pair.centre, back, pair.a0, pair.a1, ARC_STEP) : [pair.centre];
    } else if (pair.a1 - pair.a0 > 0.01) {
      innerArc = arcPoints([px, pz], pair.radius, pair.a0, pair.a1, ARC_STEP);
      outerArc = arcPoints([px, pz], pair.radius + pavement, pair.a0, pair.a1, ARC_STEP);
    } else {
      innerArc = [];
      outerArc = [];
    }
    asphalt.push(rkPoint, lk, ...innerArc);
    pavements.push({ inner: [lk, ...innerArc, rnPoint], outer: [lkOut, ...outerArc, rnOut] });
  }
  return { asphalt, aprons: [], ring: null, pavements, reach };
}

type Side = (a: number) => Vec2;

function roundaboutPieces(
  node: GraphNode,
  order: { arm: GraphNode["arms"][number]; index: number }[],
  pavement: number,
  reach: number[],
  dir: Side,
  sideA: Side,
  sideB: Side,
  at: (base: Vec2, side: Vec2, h: number, u: Vec2, t: number) => Vec2,
): JunctionPieces {
  const { outer } = ringRadii(node.roundabout!);
  const back = outer + pavement;
  const n = order.length;
  const θ = order.map((o) => o.arm.bearing);
  // Half the angle an arm's asphalt covers on the circle, shrunk where two arms would overlap.
  const α = order.map((o) => Math.asin(Math.min(0.99, o.arm.halfWidth / outer)));
  const gapStart: number[] = [];
  const gapEnd: number[] = [];
  for (let k = 0; k < n; k++) {
    const next = k + 1 < n ? θ[k + 1]! - α[k + 1]! : θ[0]! - α[0]! + TAU;
    const here = θ[k]! + α[k]!;
    const mid = (here + next) / 2;
    gapStart.push(Math.min(here, mid));
    gapEnd.push(Math.max(next, mid));
  }
  // One increasing turn from arm 0's B corner: corners and bearings exact, filled to RING_STEP.
  const angles: number[] = [];
  const marks: { a: number; m: number; e: number }[] = [];
  const fill = (to: number) => {
    const from = angles[angles.length - 1]!;
    const steps = Math.ceil(((to - from) * outer) / RING_STEP);
    for (let s = 1; s < steps; s++) {
      angles.push(from + ((to - from) * s) / steps);
    }
    angles.push(to);
  };
  angles.push(gapEnd[n - 1]! - TAU);
  for (let k = 0; k < n; k++) {
    const a = angles.length - 1;
    fill(θ[k]!);
    const m = angles.length - 1;
    fill(gapStart[k]!);
    const e = angles.length - 1;
    marks.push({ a, m, e });
    if (k + 1 < n) {
      fill(gapEnd[k]!);
    }
  }
  fill(gapEnd[n - 1]!);
  angles.pop();
  const circle = (i: number): Vec2 => {
    const a = angles[i % angles.length]!;
    return [node.pos[0] + outer * Math.cos(a), node.pos[1] + outer * Math.sin(a)];
  };
  const range = (i0: number, i1: number): Vec2[] => {
    const out: Vec2[] = [];
    for (let i = i0; i <= i1; i++) {
      out.push(circle(i));
    }
    return out;
  };

  const aprons: JunctionPieces["aprons"] = [];
  const pavements: PavementPiece[] = [];
  for (let k = 0; k < n; k++) {
    const { arm, index } = order[k]!;
    reach[index] = outer;
    const h = arm.halfWidth;
    const b = arm.bearing;
    const { a, m, e } = marks[k]!;
    aprons.push({
      arm: index,
      points: [at(node.pos, sideA(b), h, dir(b), outer), ...range(m, e).reverse()],
    });
    aprons.push({ arm: index, points: [...range(a, m), at(node.pos, sideB(b), h, dir(b), outer)] });
  }
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n;
    const here = order[k]!.arm;
    const there = order[next]!.arm;
    const i0 = marks[k]!.e;
    const i1 = next === 0 ? angles.length : marks[next]!.a;
    if (gapEnd[k]! - gapStart[k]! < 0.05) {
      continue;
    }
    // The block side leaves the arm's pavement band and meets the outer circle.
    const corner = (b: number, h: number, sign: number) => {
      const lateral = h + pavement;
      const t =
        Math.hypot(lateral, outer) < back
          ? Math.atan2(lateral, outer)
          : Math.asin(Math.min(1, lateral / back));
      return b + sign * t;
    };
    const o0 = corner(here.bearing, here.halfWidth, 1);
    let o1 = corner(there.bearing, there.halfWidth, -1);
    while (o1 < o0) {
      o1 += TAU;
    }
    if (o1 - o0 > TAU) {
      continue;
    }
    pavements.push({
      inner: [
        at(node.pos, sideA(here.bearing), here.halfWidth, dir(here.bearing), outer),
        ...range(i0, i1),
        at(node.pos, sideB(there.bearing), there.halfWidth, dir(there.bearing), outer),
      ],
      outer: [
        at(node.pos, sideA(here.bearing), here.halfWidth + pavement, dir(here.bearing), outer),
        ...arcPoints(node.pos, back, o0, o1, ARC_STEP),
        at(node.pos, sideB(there.bearing), there.halfWidth + pavement, dir(there.bearing), outer),
      ],
    });
  }
  return { asphalt: null, aprons, ring: angles, pavements, reach };
}

/**
 * Two arms of different widths, straight on or round a bend: the centreline is
 * rounded like a fused bend and the width ramps smoothly from one class to the
 * other, pavements following the edge, instead of a square step.
 */
function classTaper(
  node: GraphNode,
  order: { arm: GraphNode["arms"][number]; index: number }[],
  pavement: number,
  reach: number[],
  limits: number[] | undefined,
  frame: ((arm: number, t: number) => { point: Vec2; dir: Vec2 } | null) | undefined,
): JunctionPieces | null {
  const [a, b] = order as [(typeof order)[0], (typeof order)[0]];
  let turn = Math.abs(b.arm.bearing - a.arm.bearing);
  if (turn > Math.PI) {
    turn = TAU - turn;
  }
  const ha = a.arm.halfWidth;
  const hb = b.arm.halfWidth;
  if (ha === hb || turn < MIN_TAPER_TURN) {
    return null;
  }
  // Round a bend wide enough that the inner kerb does not fold: each arm gives two tangent lengths.
  const bend = Math.max(ha, hb) + pavement + TAPER_KERB;
  const tangent = bend * Math.tan((Math.PI - turn) / 2);
  const want = Math.max(Math.max(ha, hb) + TAPER_PER_WIDTH * Math.abs(ha - hb) * 0.5, 2 * tangent);
  const ra = Math.min(want, limits?.[a.index] ?? Infinity);
  const rb = Math.min(want, limits?.[b.index] ?? Infinity);
  reach[a.index] = ra;
  reach[b.index] = rb;
  const cut = (arm: (typeof order)[0], t: number) => {
    const θ = arm.arm.bearing;
    return (
      frame?.(arm.index, t) ?? {
        point: [node.pos[0] + Math.cos(θ) * t, node.pos[1] + Math.sin(θ) * t] as Vec2,
        dir: [Math.cos(θ), Math.sin(θ)] as Vec2,
      }
    );
  };
  const start = cut(a, ra);
  const end = cut(b, rb);
  const centre = roundCorners([start.point, node.pos, end.point], bend, 0.1);
  const along = [0];
  for (let i = 1; i < centre.length; i++) {
    const p = centre[i]!;
    const q = centre[i - 1]!;
    along.push(along[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  const total = along.at(-1)! || 1;
  // Walking from a's cut to b's: the right-hand normal, pinned to each arm's own at the ends.
  const normal = (i: number): Vec2 => {
    if (i === 0) {
      return [-start.dir[1], start.dir[0]];
    }
    if (i === centre.length - 1) {
      return [end.dir[1], -end.dir[0]];
    }
    const p = centre[i + 1]!;
    const q = centre[i - 1]!;
    const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    return [(p[1] - q[1]) / l, -(p[0] - q[0]) / l];
  };
  const chain = (side: number, extra: number): Vec2[] =>
    centre.map((p, i) => {
      const u = along[i]! / total;
      const w = ha + (hb - ha) * u * u * (3 - 2 * u) + extra;
      const nrm = normal(i);
      return [p[0] + side * nrm[0] * w, p[1] + side * nrm[1] * w];
    });
  const left = chain(1, 0);
  const right = chain(-1, 0);
  return {
    asphalt: [...left, ...[...right].reverse()],
    aprons: [],
    ring: null,
    pavements: [
      { inner: left, outer: chain(1, pavement) },
      { inner: right, outer: chain(-1, pavement) },
    ],
    reach,
  };
}
