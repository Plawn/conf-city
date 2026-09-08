import { describe, expect, test } from "bun:test";
import { Quaternion, Vector3 } from "three";
import {
  buildTrajectory,
  createPose,
  projectTrajectory,
  samplePose,
  sampleTrajectory,
} from "./trajectory";

describe("shared trajectory", () => {
  test("distance is measured in 3D, and +Z follows the slope without roll", () => {
    const g = buildTrajectory([
      [0, 0, 0],
      [3, 4, 0],
      [6, 8, 0],
    ])!;
    expect(g.total).toBe(10);
    const p = samplePose(g, 5, 0.7, createPose(), createPose());
    expect(p.x).toBeCloseTo(3, 8);
    expect(p.y).toBeCloseTo(4, 8);
    const forward = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(p.qx, p.qy, p.qz, p.qw));
    expect(forward.x).toBeCloseTo(0.6, 8);
    expect(forward.y).toBeCloseTo(0.8, 8);
    expect(forward.z).toBeCloseTo(0, 8);
    const right = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(p.qx, p.qy, p.qz, p.qw));
    expect(right.y).toBeCloseTo(0, 8);
    expect(projectTrajectory(g, 3, 4, 2)).toBeCloseTo(5, 8);
  });

  test("negative and multi-lap distances wrap; open paths clamp", () => {
    const points: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 4],
      [0, 0, 4],
    ];
    const loop = buildTrajectory(points, true)!;
    const a = sampleTrajectory(loop, -1, createPose());
    const b = sampleTrajectory(loop, 3 * loop.total - 1, createPose());
    expect([a.x, a.y, a.z]).toEqual([b.x, b.y, b.z]);
    const open = buildTrajectory(points)!;
    expect(sampleTrajectory(open, -10, createPose()).x).toBe(0);
    expect(sampleTrajectory(open, 100, createPose()).z).toBe(4);
  });

  test("position and support-point orientation are continuous at every vertex and the seam", () => {
    const g = buildTrajectory(
      [
        [0, 0, 0],
        [3, 1, 0],
        [3, 1, 3],
        [0, 0, 3],
      ],
      true,
    )!;
    for (const distance of g.cum) {
      const a = samplePose(g, distance - 1e-6, 0.7, createPose(), createPose());
      const b = samplePose(g, distance + 1e-6, 0.7, createPose(), createPose());
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(3e-6);
      expect(a.fx * b.fx + a.fy * b.fy + a.fz * b.fz).toBeGreaterThan(0.99999);
    }
  });

  test("degenerate points preserve segment attribution and never produce NaN", () => {
    expect(buildTrajectory([])).toBeNull();
    expect(
      buildTrajectory([
        [1, 0, 1],
        [1, 0, 1],
      ]),
    ).toBeNull();
    expect(
      buildTrajectory([
        [0, 0, 0],
        [NaN, 0, 0],
      ]),
    ).toBeNull();
    const g = buildTrajectory([
      [0, 0, 0],
      [0, 0, 0],
      [0, 2, 0],
    ])!;
    expect([...g.source]).toEqual([1]);
    const pose = samplePose(g, 1, 0.7, createPose(), createPose());
    expect(Object.values(pose).every(Number.isFinite)).toBe(true);
  });

  test("sampling a vertex is independent of the previous segment hint", () => {
    const g = buildTrajectory([
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
    ])!;
    const a = createPose();
    const b = createPose();
    b.segment = 1;
    sampleTrajectory(g, 1, a);
    sampleTrajectory(g, 1, b);
    expect(a).toEqual(b);
  });
});
