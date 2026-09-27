import { describe, expect, test } from "bun:test";
import type { PositionedNode } from "@/domain/types";
import { PITCH } from "@/layout/constants";
import { distToPolygon, pointInPolygon, segSegIntersect, signedArea } from "@/layout/geometry";
import { capacityRadius, islandOutline, islandShore, roughen } from "@/layout/outline";
import type { Vec2 } from "@/layout/types";

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
      expect(distToPolygon(p, smooth)).toBeLessThan(2.2 + 0.05);
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

describe("islandShore with a capacity", () => {
  const area = (poly: Vec2[]) => Math.abs(signedArea(poly)) / 2;

  test("grows to the land the machine's memory buys, never below the buildings' shore", () => {
    const nodes = placed(2, 2);
    const needed = islandOutline(nodes);
    const { outline, crowding } = islandShore(nodes, undefined, 32768);
    expect(crowding).toBeLessThan(1);
    expect(area(outline)).toBeGreaterThan(area(needed));
    expect(area(outline)).toBeGreaterThan(Math.PI * capacityRadius(32768) ** 2 * 0.97);
    for (const p of needed) {
      expect(pointInPolygon(p, outline) || distToPolygon(p, outline) < 1e-6).toBe(true);
    }
  });

  test("more memory, more land", () => {
    const nodes = placed(2, 2);
    const small = islandShore(nodes, undefined, 8192);
    const big = islandShore(nodes, undefined, 65536);
    expect(area(big.outline)).toBeGreaterThan(area(small.outline));
    expect(big.crowding!).toBeLessThan(small.crowding!);
  });

  test("a big city on a small machine is crowded and keeps the buildings' shore", () => {
    const nodes = placed(5, 4);
    const { outline, crowding } = islandShore(nodes, undefined, 2048);
    expect(crowding).toBeGreaterThan(1);
    expect(area(outline)).toBeCloseTo(area(islandOutline(nodes)), 0);
  });

  test("an overbuilt island keeps the memory's land natural and builds the rest out over the water", () => {
    const nodes = placed(5, 4);
    const shape = { seed: 4, ruggedness: 0.7 };
    const { outline, land } = islandShore(nodes, shape, 2048);
    expect(land).toBeDefined();
    expect(area(land!)).toBeLessThan(area(outline));
    for (const p of land!) {
      expect(pointInPolygon(p, outline) || distToPolygon(p, outline) < 1e-6).toBe(true);
    }
    expect(islandShore(nodes, shape, 262144).land).toBeUndefined();
  });

  test("no capacity leaves the shore and crowding alone", () => {
    const nodes = placed(3, 2);
    const shore = islandShore(nodes, { seed: 3, ruggedness: 0.6 });
    expect(shore.crowding).toBeUndefined();
    expect(shore.outline).toEqual(islandOutline(nodes, { seed: 3, ruggedness: 0.6 }));
  });

  test("is deterministic", () => {
    const nodes = placed(3, 3);
    const shape = { seed: 9, ruggedness: 0.8 };
    expect(islandShore(nodes, shape, 16384)).toEqual(islandShore(nodes, shape, 16384));
  });
});
