import { describe, expect, test } from "bun:test";
import { cellKey } from "@/layout/geometry";
import { type AnnealBody, annealLattice } from "@/layout/latticeAnneal";

/** Two neighbourhoods dealt like a chessboard: the worst possible start. */
function interleaved(): AnnealBody[] {
  const bodies: AnnealBody[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      bodies.push({ cell: [i, j], group: (i + j) % 2 === 0 ? "a" : "b" });
    }
  }
  return bodies;
}

/** Same-neighbourhood pairs on edge-sharing cells. */
function sameNeighbours(bodies: AnnealBody[]): number {
  const at = new Map(bodies.map((b) => [cellKey(b.cell), b.group]));
  let n = 0;
  for (const b of bodies) {
    for (const [di, dj] of [
      [1, 0],
      [0, 1],
    ] as const) {
      if (at.get(cellKey([b.cell[0] + di, b.cell[1] + dj])) === b.group) {
        n++;
      }
    }
  }
  return n;
}

describe("annealLattice", () => {
  test("untangles interleaved neighbourhoods, one building per cell", () => {
    const bodies = interleaved();
    expect(sameNeighbours(bodies)).toBe(0);
    annealLattice(bodies, { seed: 7, links: [], center: [1.5, 1] });
    expect(sameNeighbours(bodies)).toBeGreaterThanOrEqual(8);
    expect(new Set(bodies.map((b) => cellKey(b.cell))).size).toBe(bodies.length);
  });

  test("is deterministic", () => {
    const a = interleaved();
    const b = interleaved();
    annealLattice(a, { seed: 3, links: [[0, 11]], center: [1.5, 1] });
    annealLattice(b, { seed: 3, links: [[0, 11]], center: [1.5, 1] });
    expect(a.map((x) => x.cell)).toEqual(b.map((x) => x.cell));
  });

  test("never moves a fixed building and never lands on it", () => {
    const bodies = interleaved();
    bodies[5]!.fixed = true;
    annealLattice(bodies, { seed: 1, links: [], center: [0, 0] });
    expect(bodies[5]!.cell).toEqual([1, 2]);
    expect(bodies.filter((b) => cellKey(b.cell) === "1,2")).toHaveLength(1);
  });

  test("shortens a stretched link, but never to a diagonal", () => {
    const bodies: AnnealBody[] = [
      { cell: [0, 0], group: "" },
      { cell: [6, 5], group: "" },
    ];
    annealLattice(bodies, { seed: 9, links: [[0, 1]], center: [3, 2.5] });
    const di = Math.abs(bodies[0]!.cell[0] - bodies[1]!.cell[0]);
    const dj = Math.abs(bodies[0]!.cell[1] - bodies[1]!.cell[1]);
    expect(di + dj).toBeLessThanOrEqual(2);
    expect(di === 1 && dj === 1).toBe(false);
  });

  test("packs the core and airs the outskirts of a big city", () => {
    const bodies: AnnealBody[] = [];
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 6; j++) {
        bodies.push({ cell: [i, j], group: "" });
      }
    }
    annealLattice(bodies, { seed: 5, links: [], center: [3, 2.5] });
    const at = new Set(bodies.map((b) => cellKey(b.cell)));
    const cx = bodies.reduce((a, b) => a + b.cell[0], 0) / bodies.length;
    const cz = bodies.reduce((a, b) => a + b.cell[1], 0) / bodies.length;
    const crowd = (b: AnnealBody) =>
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].filter(([di, dj]) => at.has(cellKey([b.cell[0] + di!, b.cell[1] + dj!]))).length;
    const byRadius = [...bodies].sort(
      (a, b) =>
        Math.hypot(a.cell[0] - cx, a.cell[1] - cz) - Math.hypot(b.cell[0] - cx, b.cell[1] - cz),
    );
    const third = Math.floor(bodies.length / 3);
    const mean = (xs: AnnealBody[]) => xs.reduce((a, b) => a + crowd(b), 0) / xs.length;
    expect(mean(byRadius.slice(0, third))).toBeGreaterThan(mean(byRadius.slice(-third)) + 2);
    // Airier, not scattered: no building left without a neighbour within two cells.
    for (const b of bodies) {
      const near = bodies.some(
        (o) => o !== b && Math.abs(o.cell[0] - b.cell[0]) + Math.abs(o.cell[1] - b.cell[1]) <= 2,
      );
      expect(near).toBe(true);
    }
  });
});
