import { expect, test } from "bun:test";
import {
  arcPiece,
  capLaneOffsets,
  cappedOffset,
  drivenRadius,
  LANE_SLEW,
  linePiece,
  MAX_TURN,
  MIN_DRIVEN_RADIUS,
  offsetPiece,
  samplePath,
  slewLimit,
} from "@/geo/path";
import { laneOffsets } from "@/geo/roadStyle";
import type { Vec2 } from "@/layout/types";
import { TAU } from "@/lib/math";
import { HIT_RADIUS } from "@/sim/traffic/params";

test("a lane offset rides the radius of its own side of the arc", () => {
  const left = arcPiece([0, 0], 2, 0, Math.PI / 2);
  const right = arcPiece([0, 0], 2, Math.PI / 2, 0);
  expect(drivenRadius(left, 0.5)).toBeCloseTo(1.5, 12);
  expect(drivenRadius(right, 0.5)).toBeCloseTo(2.5, 12);
  expect(drivenRadius(linePiece([0, 0], [1, 0]), 0.5)).toBe(Infinity);
});

test("an offset wider than the arc can carry is refused, not folded", () => {
  // A boulevard's outer lane (0.70) on the old fixed 0.6 blend circle: the
  // driven radius went negative and the path turned inside out.
  const tight = arcPiece([0, 0], 0.6, 0, Math.PI / 2);
  expect(cappedOffset(tight, 0.7)).toBe(0);
  expect(drivenRadius(tight, cappedOffset(tight, 0.7))).toBe(0.6);
  const offset = offsetPiece(tight, 0.7);
  expect(offset.kind === "arc" && offset.radius).toBeGreaterThanOrEqual(MIN_DRIVEN_RADIUS);

  const roomy = arcPiece([0, 0], 2, 0, Math.PI / 2);
  expect(cappedOffset(roomy, 0.7)).toBe(0.7);
  expect(offsetPiece(roomy, 0.7)).toEqual(arcPiece([0, 0], 1.3, 0, Math.PI / 2));
  // The other way round the offset is on the outside and never needs capping.
  expect(cappedOffset(arcPiece([0, 0], 0.6, Math.PI / 2, 0), 0.7)).toBe(0.7);
});

test("sampling bounds the heading change, not only the chord", () => {
  // A full turn on a small circle: the chord bound alone would leave 24° steps.
  const points = samplePath([arcPiece([0, 0], 0.6, 0, TAU)], 0.3, MAX_TURN);
  expect(points.length).toBeGreaterThan(TAU / MAX_TURN);
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const r = points[i + 1]!;
    const t = Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0]);
    const turn = Math.abs(((t + 3 * Math.PI) % TAU) - Math.PI);
    expect(turn).toBeLessThanOrEqual(MAX_TURN + 1e-9);
  }
});

test("sampling joins pieces without repeating the shared point", () => {
  const points = samplePath([linePiece([0, 0], [1, 0]), linePiece([1, 0], [2, 0])], 0.5, MAX_TURN);
  expect(points[0]).toEqual([0, 0]);
  expect(points[points.length - 1]).toEqual([2, 0]);
  expect(points.filter(([x, z]) => x === 1 && z === 0).length).toBe(1);
});

test("a lane offset changes at a bounded rate, in both directions", () => {
  const lengths = Array.from({ length: 40 }, () => 0.2);
  const raw = lengths.map((_, i) => (i < 20 ? 0.7 : 0.25));
  const out = slewLimit(raw, lengths);
  expect(out[0]).toBeLessThan(0.7);
  expect(out[out.length - 1]).toBe(0.25);
  for (let i = 1; i < out.length; i++) {
    expect(Math.abs(out[i]! - out[i - 1]!)).toBeLessThanOrEqual(LANE_SLEW * 0.2 + 1e-12);
    expect(out[i]!).toBeLessThanOrEqual(raw[i]! + 1e-12);
  }
});

test("a corner too tight for a lane merges it inwards instead of folding it", () => {
  // A quarter circle of radius 1, sampled every 5°, with a lane 0.9 out.
  const points: Vec2[] = Array.from({ length: 19 }, (_, i) => {
    const a = (i * Math.PI) / 36;
    return [Math.cos(a), Math.sin(a)];
  });
  const lanes = points.slice(1).map((): [number, number] => [0.25, 0.9]);
  const capped = capLaneOffsets(points, lanes);
  expect(Math.max(...capped.map((l) => l[1]))).toBeLessThanOrEqual(1 - MIN_DRIVEN_RADIUS + 1e-6);
  // Lane 0 moves in with it, down to the centreline, rather than being ridden over.
  expect(Math.min(...capped.map((l) => l[0]))).toBe(0);
  for (const [a, b] of capped) {
    expect(a).toBeLessThanOrEqual(b);
  }
});

test("a boulevard's two lanes keep their spacing round a tight right turn", () => {
  const points: Vec2[] = Array.from({ length: 19 }, (_, i) => {
    const a = (i * Math.PI) / 36;
    return [1.2 * Math.cos(a), 1.2 * Math.sin(a)];
  });
  const lanes = points.slice(1).map((): [number, number] => laneOffsets("boulevard"));
  for (const [a, b] of capLaneOffsets(points, lanes)) {
    expect(b).toBeLessThanOrEqual(1.2 - MIN_DRIVEN_RADIUS + 1e-6);
    expect(b - a).toBeGreaterThanOrEqual(HIT_RADIUS);
  }
});
