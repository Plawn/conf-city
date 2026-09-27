import { describe, expect, test } from "bun:test";
import { junctionPieces } from "@/geo/junctions";
import { buildRoadGraph } from "@/geo/roadGraph";
import { FILLET, PAVEMENT } from "@/geo/roadStyle";
import type { RoadSegment, Roundabout, Vec2 } from "@/layout/types";

const seg = (points: Vec2[], klass: RoadSegment["klass"] = "street"): RoadSegment => ({
  points,
  klass,
});
const finite = (pts: Vec2[]) => pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

describe("road graph", () => {
  test("a crossroads cuts its four arms equally and gets four pavement corners", () => {
    const graph = buildRoadGraph(
      [
        seg([
          [-6, 0],
          [0, 0],
        ]),
        seg([
          [0, 0],
          [6, 0],
        ]),
        seg([
          [0, -6],
          [0, 0],
        ]),
        seg([
          [0, 0],
          [0, 6],
        ]),
      ],
      [],
      [],
    );
    const cross = graph.nodes.find((n) => n.pos[0] === 0 && n.pos[1] === 0)!;
    expect(cross.kind).toBe("junction");
    expect(cross.arms).toHaveLength(4);
    const pieces = junctionPieces(cross, PAVEMENT, FILLET);
    expect(pieces.pavements).toHaveLength(4);
    expect(new Set(pieces.reach.map((r) => r.toFixed(3))).size).toBe(1);
    // The cut lies past the fillet's tangent point: half width + fillet at a right angle.
    expect(pieces.reach[0]).toBeCloseTo(0.5 + FILLET + 0.02, 2);
    expect(pieces.asphalt).not.toBeNull();
    expect(finite(pieces.asphalt!)).toBe(true);
    for (const p of pieces.pavements) {
      expect(finite(p.inner) && finite(p.outer)).toBe(true);
      // The block side is further from the node than the kerb side.
      const nearest = (pts: Vec2[]) => Math.min(...pts.map((q) => Math.hypot(q[0], q[1])));
      expect(nearest(p.outer)).toBeGreaterThan(nearest(p.inner));
    }
  });

  test("two pieces that continue one another fuse into a rounded bend", () => {
    const graph = buildRoadGraph(
      [
        seg([
          [0, 0],
          [6, 0],
        ]),
        seg([
          [6, 0],
          [6, 6],
        ]),
      ],
      [],
      [],
    );
    expect(graph.runs).toHaveLength(1);
    const run = graph.runs[0]!;
    expect(run.points.length).toBeGreaterThan(3);
    expect(graph.nodes.every((n) => n.kind === "end")).toBe(true);
    // A dead end is capped: one arm, a half-disc, cut back by its half width.
    const end = graph.nodes[0]!;
    const pieces = junctionPieces(end, PAVEMENT, FILLET);
    expect(pieces.reach[0]).toBeCloseTo(0.5 + 0.02, 6);
    expect(pieces.pavements).toHaveLength(1);
  });

  test("a dead end is trimmed just past its driveway mouth", () => {
    const graph = buildRoadGraph(
      [
        seg([
          [0, 0],
          [6, 0],
        ]),
        seg([
          [0, 0],
          [0, 6],
        ]),
      ],
      [],
      [[3, 0]],
    );
    // Both pieces fuse through the corner; the eastern end now stops 0.9 past the mouth.
    expect(graph.runs).toHaveLength(1);
    const xs = graph.runs[0]!.points.map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(3.9);
  });

  test("a roundabout flares its street arms into the ring and cuts a deck square", () => {
    const rb: Roundabout = { center: [0, 0], radius: 1.2, klass: "avenue" };
    const graph = buildRoadGraph(
      [
        seg(
          [
            [-6, 0],
            [0, 0],
          ],
          "avenue",
        ),
        seg(
          [
            [0, 0],
            [0, 6],
          ],
          "avenue",
        ),
      ],
      [rb],
      [],
      [{ at: [0, 0], toward: [10, 0], halfWidth: 0.75, klass: "avenue" }],
    );
    const node = graph.nodes.find((n) => n.kind === "roundabout")!;
    expect(node.arms).toHaveLength(3);
    const pieces = junctionPieces(node, PAVEMENT, FILLET);
    expect(pieces.asphalt).toBeNull();
    expect(pieces.pavements).toHaveLength(3);
    // The deck (virtual arm) stops at the tarmac; the streets reach past it by their flare.
    const deck = node.arms.findIndex((a) => a.run < 0);
    pieces.reach.forEach((r, k) => {
      if (k === deck) {
        expect(r).toBeCloseTo(2.05, 6);
      } else {
        expect(r).toBeGreaterThan(2.1);
      }
    });
    // No crescent: every apron runs from the square cut down to the tarmac circle.
    expect(pieces.aprons).toHaveLength(6);
    const ring = pieces.ring!;
    for (let i = 1; i < ring.length; i++) {
      expect(ring[i]!).toBeGreaterThan(ring[i - 1]!);
    }
    expect(ring.at(-1)! - ring[0]!).toBeLessThan(Math.PI * 2);
    for (const { points } of pieces.aprons) {
      const radii = points.map((p) => Math.hypot(p[0], p[1]));
      expect(Math.min(...radii)).toBeCloseTo(2.05, 6);
      expect(Math.max(...radii)).toBeGreaterThan(2.05);
    }
    // The kerb of each pavement piece starts on an arm's asphalt edge at the cut, never dips
    // inside the tarmac circle, and bends smoothly into it (the flare is tangent at both ends).
    const reaches = new Set(pieces.reach.map((r) => r.toFixed(6)));
    for (const p of pieces.pavements) {
      const start = p.inner[0]!;
      const along = Math.max(Math.abs(start[0]), Math.abs(start[1]));
      expect(reaches.has(along.toFixed(6))).toBe(true);
      for (const q of p.inner) {
        expect(Math.hypot(q[0], q[1])).toBeGreaterThan(2.05 - 1e-6);
      }
    }
    const flared = pieces.pavements.find((p) => {
      const [x, z] = p.inner[0]!;
      return Math.max(Math.abs(x), Math.abs(z)) > 2.1;
    })!;
    for (let i = 1; i + 1 < flared.inner.length; i++) {
      const [a, b, c] = [flared.inner[i - 1]!, flared.inner[i]!, flared.inner[i + 1]!];
      const turn = Math.abs(
        Math.atan2(
          (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
          (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]),
        ),
      );
      expect(turn).toBeLessThan(0.35);
    }
  });

  test("a short run bounds the reach and the fillet shrinks to fit", () => {
    const graph = buildRoadGraph(
      [
        seg([
          [-6, 0],
          [0, 0],
        ]),
        seg([
          [0, 0],
          [6, 0],
        ]),
        seg([
          [0, -6],
          [0, 0],
        ]),
        seg([
          [0, 0],
          [0, 6],
        ]),
      ],
      [],
      [],
    );
    const cross = graph.nodes.find((n) => n.pos[0] === 0 && n.pos[1] === 0)!;
    const free = junctionPieces(cross, PAVEMENT, FILLET);
    const limits = cross.arms.map(() => 0.8);
    const tight = junctionPieces(cross, PAVEMENT, FILLET, limits);
    for (const r of tight.reach) {
      expect(r).toBeLessThanOrEqual(0.8);
      expect(r).toBeLessThan(free.reach[0]!);
    }
    expect(finite(tight.asphalt!)).toBe(true);
  });

  test("a class change round a corner is one smooth, simple cap meeting both cuts", () => {
    const graph = buildRoadGraph(
      [
        seg([
          [0, 0],
          [8, 0],
        ]),
        seg(
          [
            [0, 0],
            [0, 8],
          ],
          "avenue",
        ),
      ],
      [],
      [],
    );
    const node = graph.nodes.find((n) => n.pos[0] === 0 && n.pos[1] === 0)!;
    expect(node.arms).toHaveLength(2);
    const pieces = junctionPieces(node, PAVEMENT, FILLET);
    const cap = pieces.asphalt!;
    expect(finite(cap)).toBe(true);
    expect(pieces.pavements).toHaveLength(2);
    // Each arm's cut is a vertex pair of the cap, as wide as that arm.
    for (const [k, arm] of node.arms.entries()) {
      const t = pieces.reach[k]!;
      const c: Vec2 = [Math.cos(arm.bearing) * t, Math.sin(arm.bearing) * t];
      const onCut = cap.filter(
        (p) =>
          Math.abs((p[0] - c[0]) * Math.cos(arm.bearing) + (p[1] - c[1]) * Math.sin(arm.bearing)) <
          1e-6,
      );
      const widths = onCut.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
      expect(Math.max(...widths)).toBeCloseTo(arm.halfWidth, 6);
    }
    // No two non-adjacent edges of the cap cross.
    const cross = (a: Vec2, b: Vec2, c: Vec2) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const n = cap.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) {
          continue;
        }
        const [a, b, c, d] = [cap[i]!, cap[(i + 1) % n]!, cap[j]!, cap[(j + 1) % n]!];
        const hit =
          cross(a, b, c) * cross(a, b, d) < -1e-12 && cross(c, d, a) * cross(c, d, b) < -1e-12;
        expect(hit).toBe(false);
      }
    }
  });
});
