import { describe, expect, test } from "bun:test";
import { junctionPieces } from "@/components/geo/junctions";
import { buildRoadGraph } from "@/components/geo/roadGraph";
import { FILLET, PAVEMENT } from "@/components/geo/roadStyle";
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

  test("a roundabout cuts every arm at its tarmac ring and opens the pavement for a deck", () => {
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
      [{ at: [0, 0], toward: [10, 0], halfWidth: 0.75 }],
    );
    const node = graph.nodes.find((n) => n.kind === "roundabout")!;
    expect(node.arms).toHaveLength(3);
    const pieces = junctionPieces(node, PAVEMENT, FILLET);
    expect(pieces.asphalt).toBeNull();
    expect(pieces.pavements).toHaveLength(3);
    for (const r of pieces.reach) {
      expect(r).toBeCloseTo(2.05, 6);
    }
  });
});
