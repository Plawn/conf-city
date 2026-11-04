import { describe, expect, test } from "bun:test";
import { CLOUD_DROP, cityLift, ISLAND_DROP } from "@/domain/replayLift";

describe("cityLift", () => {
  test("islands rise from the sea, clouds come down from the sky", () => {
    expect(cityLift(0, false)).toBe(-ISLAND_DROP);
    expect(cityLift(0, true)).toBe(CLOUD_DROP);
    expect(cityLift(1, false)).toBe(-0);
    expect(cityLift(1, true)).toBe(0);
  });

  test("moves monotonically and settles gently", () => {
    let prev = cityLift(0, true);
    for (let p = 0.05; p <= 1; p += 0.05) {
      const y = cityLift(p, true);
      expect(y).toBeLessThan(prev);
      prev = y;
    }
    expect(cityLift(0.9, true)).toBeLessThan(0.02 * CLOUD_DROP);
    expect(cityLift(-1, false)).toBe(-ISLAND_DROP);
  });
});
