import { describe, expect, test } from "bun:test";
import { buildingRise, DUST_SEC, dustAt, dustPuffs } from "@/domain/replayRise";

describe("buildingRise", () => {
  test("starts flat and narrow, ends exactly at rest", () => {
    const [xz0, y0] = buildingRise(0);
    expect(y0).toBeCloseTo(0, 9);
    expect(xz0).toBeLessThan(0.6);
    expect(buildingRise(1)).toEqual([1, 1]);
    expect(buildingRise(2)).toEqual([1, 1]);
  });

  test("overshoots its height a little, then squashes wider as it settles", () => {
    const ys = Array.from({ length: 101 }, (_, i) => buildingRise(i / 100)[1]);
    const peak = Math.max(...ys);
    expect(peak).toBeGreaterThan(1.03);
    expect(peak).toBeLessThan(1.1);
    expect(ys.indexOf(peak)).toBeGreaterThan(60);
    expect(buildingRise(0.85)[0]).toBeGreaterThan(1);
  });

  test("is continuous", () => {
    for (let p = 0; p < 1; p += 0.01) {
      const [a, b] = [buildingRise(p), buildingRise(p + 0.01)];
      expect(Math.abs(a[0] - b[0])).toBeLessThan(0.05);
      expect(Math.abs(a[1] - b[1])).toBeLessThan(0.05);
    }
  });
});

describe("construction dust", () => {
  test("seeded, rings outward, gone once settled", () => {
    expect(dustPuffs("a/b", 8)).toEqual(dustPuffs("a/b", 8));
    const p = dustPuffs("a/b", 8)[0]!;
    const out = { x: 0, y: 0, z: 0, scale: 0 };
    const r = (age: number) => {
      dustAt(p, age, out);
      return Math.hypot(out.x, out.z);
    };
    expect(r(0.8)).toBeGreaterThan(r(0.2));
    expect(dustAt(p, DUST_SEC * 0.5, out).scale).toBeGreaterThan(0);
    expect(dustAt(p, DUST_SEC, out).scale).toBe(0);
    expect(dustAt(p, 0, out).scale).toBe(0);
  });
});
