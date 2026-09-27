import { describe, expect, test } from "bun:test";
import { FOOTPRINT_MAX, FOOTPRINT_MIN, footprintRadiusFor, LOT_MB } from "@/domain/capacity";

describe("footprintRadiusFor", () => {
  test("area grows with memory and fills the plot at one lot", () => {
    expect(footprintRadiusFor({ memoryMb: LOT_MB })).toBeCloseTo(FOOTPRINT_MAX);
    const quarter = footprintRadiusFor({ memoryMb: LOT_MB / 4 })!;
    expect(quarter).toBeCloseTo(FOOTPRINT_MAX / 2);
  });

  test("clamps to the plot and to a clickable minimum", () => {
    expect(footprintRadiusFor({ memoryMb: LOT_MB * 8 })).toBe(FOOTPRINT_MAX);
    expect(footprintRadiusFor({ memoryMb: 1 })).toBe(FOOTPRINT_MIN);
    expect(footprintRadiusFor({ memoryMb: -5 })).toBe(FOOTPRINT_MIN);
  });

  test("no memory sample, no footprint", () => {
    expect(footprintRadiusFor(undefined)).toBeUndefined();
    expect(footprintRadiusFor({ cpu: 50 })).toBeUndefined();
  });
});
