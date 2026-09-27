import { describe, expect, test } from "bun:test";
import {
  arcLength,
  cutPolyline,
  offsetPolyline,
  pointAt,
  projectOnPolyline,
  roundCorners,
  subPolyline,
} from "@/geo/polyline";
import type { Vec2 } from "@/layout/types";

const L: Vec2[] = [
  [0, 0],
  [6, 0],
  [6, 6],
];

describe("polyline", () => {
  test("arc length and points along it", () => {
    expect(arcLength(L)).toBe(12);
    expect(pointAt(L, 3).point).toEqual([3, 0]);
    expect(pointAt(L, 9).point).toEqual([6, 3]);
    expect(pointAt(L, 9).dir).toEqual([0, 1]);
  });

  test("cutting keeps the interior vertices and interpolates the ends", () => {
    expect(cutPolyline(L, 1, 1)).toEqual([
      [1, 0],
      [6, 0],
      [6, 5],
    ]);
    expect(subPolyline(L, 2, 4)).toEqual([
      [2, 0],
      [4, 0],
    ]);
    expect(cutPolyline(L, 7, 7)).toEqual([]);
  });

  test("offset goes to the ribbon's right and mitres the bend", () => {
    const off = offsetPolyline(L, 1);
    // Heading +x, right is -z; heading +z, right is +x.
    expect(off[0]).toEqual([0, -1]);
    expect(off[2]).toEqual([7, 6]);
    // The mitre is the corner of both offset lines.
    expect(off[1]![0]).toBeCloseTo(7);
    expect(off[1]![1]).toBeCloseTo(-1);
  });

  test("projection reports the side the point lies on", () => {
    const right = projectOnPolyline(L, [3, -2]);
    expect(right.t).toBe(3);
    expect(right.dist).toBe(2);
    expect(right.side).toBe(1);
    expect(projectOnPolyline(L, [3, 2]).side).toBe(-1);
    expect(projectOnPolyline(L, [6, 4]).t).toBe(10);
  });

  test("rounding a corner keeps the ends, stays within the radius and never overlaps the half edges", () => {
    const rounded = roundCorners(L, 1.5, 0.3);
    expect(rounded[0]).toEqual([0, 0]);
    expect(rounded[rounded.length - 1]).toEqual([6, 6]);
    expect(rounded.length).toBeGreaterThan(4);
    // Every interior point sits within the corner's 1.5 square, none on the vertex itself.
    for (const p of rounded.slice(1, -1)) {
      expect(p[0]).toBeGreaterThanOrEqual(4.5 - 1e-9);
      expect(p[1]).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(Math.hypot(p[0] - 6, p[1])).toBeGreaterThan(0.4);
    }
    // A short edge caps the radius at half its length.
    const tight = roundCorners(
      [
        [0, 0],
        [1, 0],
        [1, 6],
      ],
      1.5,
      0.3,
    );
    expect(tight[1]![0]).toBeCloseTo(0.5);
    // Vertices the predicate rejects stay put.
    expect(roundCorners(L, 1.5, 0.3, () => false)).toEqual(L);
  });
});
