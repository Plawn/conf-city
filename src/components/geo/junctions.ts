import type { Vec2 } from "../../layout/types";
import { TAU } from "../../lib/math";
import { arcPoints } from "./polyline";
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
 * Roundabouts are simpler: every arm is cut at the tarmac ring, the asphalt is
 * the ring itself (drawn elsewhere), and the pavement is the annulus outside it
 * with a gap wherever an arm leaves.
 */

export interface PavementPiece {
  /** Asphalt-side chain, then the block-side chain, both open and running the same way. */
  inner: Vec2[];
  outer: Vec2[];
}

export interface JunctionPieces {
  /** Closed asphalt outline (`null` for a roundabout: the ring covers it). */
  asphalt: Vec2[] | null;
  pavements: PavementPiece[];
  /** Cut distance along each of `node.arms`, same order. */
  reach: number[];
}

/** Below this angle short of a straight line, two arms are treated as one continuing road. */
const FLAT = 0.5;
const ARC_STEP = 0.12;
/** Angular clearance either side of an arm on a roundabout's pavement ring. */
const RING_GAP = 0.03;

type Pair =
  | { kind: "fillet"; centre: Vec2; radius: number; a0: number; a1: number; tk: number; tn: number }
  | { kind: "round"; radius: number; a0: number; a1: number };

export function junctionPieces(node: GraphNode, pavement: number, fillet: number): JunctionPieces {
  const [px, pz] = node.pos;
  const order = node.arms
    .map((arm, index) => ({ arm, index }))
    .sort((a, b) => a.arm.bearing - b.arm.bearing);
  const n = order.length;
  const reach = node.arms.map(() => 0);
  if (n === 0) {
    return { asphalt: null, pavements: [], reach };
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
    const { outer } = ringRadii(node.roundabout);
    const pavements: PavementPiece[] = [];
    for (let k = 0; k < n; k++) {
      const here = order[k]!.arm;
      const next = order[(k + 1) % n]!.arm;
      reach[order[k]!.index] = outer;
      const clear = (h: number) => Math.asin(Math.min(1, h / outer)) + RING_GAP;
      const a0 = here.bearing + clear(here.halfWidth);
      let a1 = next.bearing - clear(next.halfWidth);
      if (k + 1 >= n) {
        a1 += TAU;
      }
      while (a1 < a0) {
        a1 += TAU;
      }
      if (a1 - a0 < 0.05 || a1 - a0 > TAU) {
        continue;
      }
      pavements.push({
        inner: arcPoints(node.pos, outer, a0, a1, ARC_STEP),
        outer: arcPoints(node.pos, outer + pavement, a0, a1, ARC_STEP),
      });
    }
    return { asphalt: null, pavements, reach };
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
        const d = fillet / Math.tan(delta / 2);
        const x = at(node.pos, sideA(θk), hk, uk, tk);
        const bis: Vec2 = [uk[0] + un[0], uk[1] + un[1]];
        const bl = Math.hypot(bis[0], bis[1]);
        const c = fillet / Math.sin(delta / 2);
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
        pair = { kind: "fillet", centre, radius: fillet, a0, a1, tk: tk + d, tn: tn + d };
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
    const lk = at(node.pos, sideA(θk), here.arm.halfWidth, dir(θk), rk);
    const rkPoint = at(node.pos, sideB(θk), here.arm.halfWidth, dir(θk), rk);
    const rnPoint = at(node.pos, sideB(θn), next.arm.halfWidth, dir(θn), rn);
    const lkOut = at(node.pos, sideA(θk), here.arm.halfWidth + pavement, dir(θk), rk);
    const rnOut = at(node.pos, sideB(θn), next.arm.halfWidth + pavement, dir(θn), rn);

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
  return { asphalt, pavements, reach };
}
