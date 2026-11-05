import { describe, expect, test } from "bun:test";
import { CLOUD_DROP, cityLift, ISLAND_DROP } from "@/domain/replayLift";

describe("cityLift", () => {
  test("islands rise from the sea, clouds come down from the sky", () => {
    expect(cityLift(0, false)).toBe(-ISLAND_DROP);
    expect(cityLift(0, true)).toBe(CLOUD_DROP);
    expect(cityLift(1, false)).toBeCloseTo(0, 9);
    expect(cityLift(1, true)).toBeCloseTo(0, 9);
    expect(cityLift(-1, false)).toBe(-ISLAND_DROP);
  });

  test("comes most of the way first, bobs once past rest, then settles", () => {
    let prev = cityLift(0, true);
    for (let p = 0.05; p <= 0.6; p += 0.05) {
      const y = cityLift(p, true);
      expect(y).toBeLessThan(prev);
      prev = y;
    }
    const dip = Math.min(...[0.75, 0.8, 0.85, 0.9].map((p) => cityLift(p, true)));
    expect(dip).toBeLessThan(0);
    expect(dip).toBeGreaterThan(-0.05 * CLOUD_DROP);
    expect(cityLift(0.85, false)).toBeGreaterThan(0);
    expect(Math.abs(cityLift(0.99, true))).toBeLessThan(0.01 * CLOUD_DROP);
  });
});
