import { describe, expect, test } from "bun:test";
import type { PositionedNode } from "@/domain/types";
import { PITCH } from "@/layout/constants";
import { pointInPolygon, segSegIntersect, signedArea } from "@/layout/geometry";
import { islandOutline, roughen } from "@/layout/outline";

function placed(w: number, h: number): PositionedNode[] {
  const out: PositionedNode[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      out.push({
        id: `n${i}${j}`,
        cityId: "c",
        type: "app",
        label: "",
        links: [],
        position: [i * PITCH, 0, j * PITCH],
      });
    }
  }
  return out;
}

function selfIntersects(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) {
        continue; // adjacent through the wrap
      }
      if (segSegIntersect(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) {
        return true;
      }
    }
  }
  return false;
}
type Vec2 = [number, number];

function distanceToPolygon(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t)));
  }
  return best;
}

describe("islandOutline", () => {
  const nodes = placed(3, 2);

  test("ruggedness 0 (or no shape) is the exact rounded offset", () => {
    const plain = islandOutline(nodes);
    expect(islandOutline(nodes, { seed: 7, ruggedness: 0 })).toEqual(plain);
  });

  test("is deterministic for a seed and differs across seeds", () => {
    const a = islandOutline(nodes, { seed: 1, ruggedness: 0.7 });
    const b = islandOutline(nodes, { seed: 1, ruggedness: 0.7 });
    const c = islandOutline(nodes, { seed: 2, ruggedness: 0.7 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("only pushes the coast outward: the smooth shore stays on dry land", () => {
    const smooth = islandOutline(nodes);
    for (const ruggedness of [0.25, 0.6, 1]) {
      for (const seed of [1, 42, 1337]) {
        const rough = islandOutline(nodes, { seed, ruggedness });
        expect(signedArea(rough)).toBeGreaterThan(signedArea(smooth));
        for (const p of smooth) {
          expect(pointInPolygon(p, rough)).toBe(true);
        }
      }
    }
  });

  test("never self-intersects, even at full ruggedness", () => {
    for (const shape of [placed(1, 1), placed(2, 1), placed(4, 4), placed(6, 2)]) {
      for (const seed of [1, 2, 3, 99]) {
        expect(selfIntersects(islandOutline(shape, { seed, ruggedness: 1 }))).toBe(false);
      }
    }
  });

  test("stays within the noise amplitude of the smooth coast", () => {
    const smooth = islandOutline(nodes);
    const rough = islandOutline(nodes, { seed: 5, ruggedness: 1 });
    for (const p of rough) {
      expect(distanceToPolygon(p, smooth)).toBeLessThan(2.2 + 0.05);
    }
  });

  test("the empty city's disc is roughened too", () => {
    expect(islandOutline([], { seed: 1, ruggedness: 0.5 })).not.toEqual(islandOutline([]));
  });
});

describe("roughen", () => {
  test("leaves degenerate input alone", () => {
    expect(roughen([], 1, 1)).toEqual([]);
    const tri: Vec2[] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    expect(roughen(tri, 1, 0)).toBe(tri);
  });
});
