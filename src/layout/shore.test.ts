import { describe, expect, test } from "bun:test";
import { buildShoreField, sampleShore } from "./shore";
import type { Vec2 } from "./types";

const square: Vec2[] = [
  [-10, -10],
  [10, -10],
  [10, 10],
  [-10, 10],
];

describe("buildShoreField", () => {
  test("is zero on the outline and saturates at reach", () => {
    const field = buildShoreField([square], 6);
    expect(sampleShore(field, 10, 0)).toBeLessThan(field.cell);
    expect(sampleShore(field, 0, -10)).toBeLessThan(field.cell);
    // Far corner of the grid: open sea.
    expect(sampleShore(field, field.originX, field.originZ)).toBe(6);
  });

  test("grows monotonically away from the shore", () => {
    const field = buildShoreField([square], 6);
    let prev = -1;
    for (let x = 10; x <= 18; x += 0.5) {
      const d = sampleShore(field, x, 0);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    // Two units off the coast reads as roughly two units.
    expect(sampleShore(field, 12, 0)).toBeCloseTo(2, 0);
  });

  test("border texels are open sea, so clamp-to-edge means ocean", () => {
    const field = buildShoreField([square], 6);
    const { size, data } = field;
    for (let i = 0; i < size; i++) {
      expect(data[i]).toBe(255); // first row
      expect(data[(size - 1) * size + i]).toBe(255); // last row
      expect(data[i * size]).toBe(255); // first column
      expect(data[i * size + size - 1]).toBe(255); // last column
    }
  });

  test("merges several islands into one field", () => {
    const other: Vec2[] = square.map(([x, z]) => [x + 60, z]);
    const field = buildShoreField([square, other], 6);
    expect(sampleShore(field, 70, 0)).toBeLessThan(field.cell);
    // Halfway between the two islands, 20 units from either shore: open sea.
    expect(sampleShore(field, 30, 0)).toBe(6);
  });

  test("no outline gives a single open-sea texel", () => {
    const field = buildShoreField([], 6);
    expect(field.size).toBe(1);
    expect(field.data[0]).toBe(255);
  });
});
