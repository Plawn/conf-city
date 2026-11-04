import { describe, expect, test } from "bun:test";
import { cloudOutline, cloudPuffs } from "../../src/layout/cloud";
import type { Vec2 } from "../../src/layout/types";

const square: Vec2[] = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];

describe("cloudPuffs", () => {
  test("is deterministic per city", () => {
    expect(cloudPuffs("azure", square, [0, 0])).toEqual(cloudPuffs("azure", square, [0, 0]));
    expect(cloudPuffs("azure", square, [0, 0])).not.toEqual(cloudPuffs("groq", square, [0, 0]));
  });

  test("hangs under the platform and stays near the outline", () => {
    const puffs = cloudPuffs("azure", square, [0, 0]);
    expect(puffs.length).toBeGreaterThan(30);
    for (const p of puffs) {
      expect(p.y).toBeLessThan(0.3);
      expect(Math.max(Math.abs(p.x), Math.abs(p.z))).toBeLessThan(5.6);
    }
  });

  test("leaves room around the buildings", () => {
    const puffs = cloudPuffs("azure", square, [0, 0], [[0, 0]]);
    const near = puffs.filter((p) => p.y > -0.5 && Math.hypot(p.x, p.z) < 1.3);
    expect(near).toEqual([]);
  });

  test("a degenerate outline has no cloud", () => {
    expect(cloudPuffs("azure", [[0, 0]], [0, 0])).toEqual([]);
  });
});

describe("cloudOutline", () => {
  test("a one-service cloud keeps a readable size", () => {
    const outline = cloudOutline([
      { id: "llm", cityId: "groq", type: "app", label: "LLM", links: [], position: [0, 0, 0] },
    ]);
    expect(Math.max(...outline.map(([x, z]) => Math.hypot(x, z)))).toBeGreaterThanOrEqual(5.9);
  });
});
