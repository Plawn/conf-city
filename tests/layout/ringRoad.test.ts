import { describe, expect, test } from "bun:test";
import { roundedOffset } from "@/layout/geometry";
import { attachRing, ringHit } from "@/layout/ringRoad";
import type { Vec2 } from "@/layout/types";

const square: Vec2[] = [
  [-6, -6],
  [6, -6],
  [6, 6],
  [-6, 6],
];

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Distance from `p` to the closed polygon `poly`. */
function distToPolygon(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)),
    );
    best = Math.min(best, dist(p, [a[0] + dx * t, a[1] + dz * t]));
  }
  return best;
}

describe("roundedOffset", () => {
  test("every vertex sits exactly d away from the hull, and the corners are arcs", () => {
    const ring = roundedOffset(square, 4);
    expect(ring.length).toBeGreaterThan(square.length * 3);
    for (const p of ring) {
      expect(distToPolygon(p, square)).toBeCloseTo(4, 6);
    }
    // No duplicate consecutive vertices, closed loop without repeating the first.
    for (let i = 0; i < ring.length; i++) {
      expect(dist(ring[i]!, ring[(i + 1) % ring.length]!)).toBeGreaterThan(1e-6);
    }
  });

  test("a single point becomes a circle", () => {
    const ring = roundedOffset([[2, 3]], 5);
    expect(ring.length).toBeGreaterThanOrEqual(8);
    for (const p of ring) {
      expect(dist(p, [2, 3])).toBeCloseTo(5, 6);
    }
  });
});

describe("ringHit / attachRing", () => {
  test("a ray from the centre exits the ring on the facing side", () => {
    const ring = roundedOffset(square, 4);
    const hit = ringHit([0, 0], [1, 0], ring);
    expect(hit).not.toBeNull();
    expect(hit!.point[0]).toBeCloseTo(10, 6);
    expect(hit!.point[1]).toBeCloseTo(0, 6);
  });

  test("attach inserts the hit as a vertex, keeping the loop order", () => {
    const ring = roundedOffset(square, 4);
    const before = ring.length;
    const hit = ringHit([0, 0], [0, 1], ring)!;
    const v = attachRing(ring, hit);
    expect(ring).toContain(v);
    expect(ring.length).toBe(before + 1);
    const i = ring.indexOf(v);
    // Still a simple loop: the new vertex lies between its two neighbours.
    const a = ring[(i + ring.length - 1) % ring.length]!;
    const b = ring[(i + 1) % ring.length]!;
    expect(distToPolygon(v, [a, b, b])).toBeLessThan(1e-6);
    for (const p of ring) {
      expect(distToPolygon(p, square)).toBeCloseTo(4, 6);
    }
  });

  test("a hit next to an existing vertex moves that vertex instead of adding a micro-step", () => {
    const ring = roundedOffset(square, 4);
    const target = ring[3]!;
    const hit = { point: [target[0] + 0.1, target[1]] as Vec2, edge: 3 };
    const before = ring.length;
    const v = attachRing(ring, hit);
    expect(ring.length).toBe(before);
    expect(ring[3]).toBe(v);
    expect(v[0]).toBeCloseTo(target[0] + 0.1, 9);
  });

  test("a pinned vertex is reused rather than moved", () => {
    const ring = roundedOffset(square, 4);
    const target = ring[3]!;
    const v = attachRing(ring, { point: [target[0] + 0.1, target[1]], edge: 3 }, new Set([target]));
    expect(v).toBe(target);
  });
});
