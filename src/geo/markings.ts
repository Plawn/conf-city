import { TERRAIN } from "../domain/nodeStyle";
import type { Driveway, Vec2 } from "../layout/types";
import { projectOnPolyline } from "./polyline";
import { type Arm, type GraphNode, ON_LINE } from "./roadGraph";
import { CLASS_STYLE } from "./roadStyle";

/**
 * Where the painted markings and the pavement openings of a run go, as arc-length
 * intervals along its cut polyline: pure layout, drawn by `components/roads/buildRoadGeometry.ts`.
 */

export const DASH_WIDTH = 0.1;
export const DASH_LENGTH = 0.5;
export const DASH_PERIOD = 1.3;
export const LANE_DASH_LENGTH = 0.3;
export const LANE_DASH_PERIOD = 0.9;
export const LINE_WIDTH = 0.06;
/** Edge lines sit this far inside the asphalt edge. */
export const EDGE_INSET = 0.12;
/** Centre markings stay clear of the ends: a plain end, or a crossing with its zebra and stop line. */
export const MARGIN_PLAIN = 0.5;
export const MARGIN_JUNCTION = 1.3;
const ZEBRA_FROM = 0.25;
const ZEBRA_TO = 0.75;
const ZEBRA_STEP = 0.2;
export const ZEBRA_BAND = 0.12;
const STOP_AT = 0.9;
const STOP_WIDTH = 0.12;
const GIVE_WAY_PERIOD = 0.2;
/** Half the pavement gap at a driveway mouth: the driveway plus a kerb drop each side. */
export const MOUTH_GAP = TERRAIN.drivewayWidth / 2 + 0.1;
/** Pavement spans shorter than this are not drawn. */
const MIN_SPAN = 0.05;

export type Interval = [number, number];

/** A crossing that gets a zebra and a stop line on every arm. */
export const isCrossing = (node: GraphNode) => node.kind === "junction" && node.arms.length >= 3;

/**
 * What an arm gets painted where it meets `node`: a zebra and a stop line at a
 * plain crossing; where a spur joins the ring road, the ring runs through
 * unmarked and only the spur gets a give-way line.
 */
export type ArmMarking = "none" | "crossing" | "giveWay";

export function armMarking(node: GraphNode, arm: Arm | undefined): ArmMarking {
  if (!arm || !isCrossing(node)) {
    return "none";
  }
  if (node.arms.filter((a) => a.ring).length < 2) {
    return "crossing";
  }
  return arm.ring ? "none" : "giveWay";
}

/** Centre-marking margin at an end of a run. */
export const endMargin = (marking: ArmMarking) =>
  marking === "none" ? MARGIN_PLAIN : MARGIN_JUNCTION;

/** Lateral dashes of a give-way line across the lane between offsets `d0` and `d1`. */
export function giveWayDashes(d0: number, d1: number): Interval[] {
  const [lo, hi] = d0 < d1 ? [d0, d1] : [d1, d0];
  const count = Math.max(1, Math.round((hi - lo) / GIVE_WAY_PERIOD));
  const step = (hi - lo) / count;
  return Array.from(
    { length: count },
    (_, k): Interval => [lo + k * step + step * 0.2, lo + (k + 1) * step - step * 0.2],
  );
}

/** Driveway-mouth gaps on each side of `cut`: `[0]` the negative side, `[1]` the positive one. */
export function mouthGaps(cut: Vec2[], driveways: Driveway[]): Interval[][] {
  const gaps: Interval[][] = [[], []];
  for (const d of driveways) {
    const hit = projectOnPolyline(cut, d.mouth);
    if (hit.dist > ON_LINE) {
      continue;
    }
    const side = projectOnPolyline(cut, d.door).side > 0 ? 1 : 0;
    gaps[side]!.push([hit.t - MOUTH_GAP, hit.t + MOUTH_GAP]);
  }
  return gaps;
}

/** What is left of `[0, length]` once `holes` are cut out (sorted in place), minus the slivers. */
export function pavementSpans(holes: Interval[], length: number): Interval[] {
  holes.sort((a, b) => a[0] - b[0]);
  let from = 0;
  const spans: Interval[] = [];
  for (const [a, b] of holes) {
    if (a > from) {
      spans.push([from, a]);
    }
    from = Math.max(from, b);
  }
  if (from < length) {
    spans.push([from, length]);
  }
  return spans.filter(([a, b]) => b - a >= MIN_SPAN);
}

/** Start of every dash of `dash` length every `period`, centred between the two margins. */
export function dashStarts(
  length: number,
  marginStart: number,
  marginEnd: number,
  dash: number,
  period: number,
): number[] {
  const usable = length - marginStart - marginEnd;
  if (usable < dash) {
    return [];
  }
  const gap = period - dash;
  const count = Math.floor((usable + gap) / period);
  const first = marginStart + (usable - (count * period - gap)) / 2;
  const starts: number[] = [];
  for (let k = 0; k < count; k++) {
    starts.push(first + k * period);
  }
  return starts;
}

/** Lateral offsets of the zebra bands across a run of half-width `h`. */
export function zebraOffsets(h: number): number[] {
  const offsets: number[] = [];
  for (let d = -h + EDGE_INSET; d <= h - EDGE_INSET + 1e-6; d += ZEBRA_STEP) {
    offsets.push(d);
  }
  return offsets;
}

/** The zebra and the stop line of a crossing arm at `from`, heading into the run when `sign > 0`. */
export function crossingIntervals(from: number, sign: number): { zebra: Interval; stop: Interval } {
  const zebra: Interval =
    sign > 0 ? [from + ZEBRA_FROM, from + ZEBRA_TO] : [from - ZEBRA_TO, from - ZEBRA_FROM];
  const stop: Interval =
    sign > 0
      ? [from + STOP_AT, from + STOP_AT + STOP_WIDTH]
      : [from - STOP_AT - STOP_WIDTH, from - STOP_AT];
  return { zebra, stop };
}

/**
 * A driveway butts against the edge of the street it opens onto — it starts half
 * the street's width out from the mouth, which is on the centreline — and runs
 * straight to the door; `null` when the door is inside that setback.
 */
export function drivewayRun(d: Driveway): [Vec2, Vec2] | null {
  const dx = d.door[0] - d.mouth[0];
  const dz = d.door[1] - d.mouth[1];
  const length = Math.hypot(dx, dz);
  const setback = CLASS_STYLE[d.klass].width / 2;
  if (length <= setback) {
    return null;
  }
  const from: Vec2 = [d.mouth[0] + (dx / length) * setback, d.mouth[1] + (dz / length) * setback];
  return [from, d.door];
}
