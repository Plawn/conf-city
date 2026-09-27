import { expect, test } from "bun:test";
import { buildMetroTrack, metroTrackPoints } from "@/components/mobility/metroTrack";
import type { Vec2 } from "@/layout/types";

/** A convex ring, roughly the shape `buildRing` produces: an octagon. */
function octagon(radius: number): Vec2[] {
  return Array.from({ length: 8 }, (_, i): Vec2 => {
    const a = (i * Math.PI) / 4;
    return [radius * Math.cos(a), radius * Math.sin(a)];
  });
}

/** Signed heading change from segment `a` to segment `b`, in degrees. */
function turn(t: ReturnType<typeof buildMetroTrack>, a: number, b: number): number {
  const g = t!;
  const cross = g.dirX[a]! * g.dirZ[b]! - g.dirZ[a]! * g.dirX[b]!;
  const dot = g.dirX[a]! * g.dirX[b]! + g.dirZ[a]! * g.dirZ[b]!;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

test("the viaduct goes round the ring exactly once, with no corner a train could not take", () => {
  const track = buildMetroTrack(octagon(10))!;
  const segments = track.dirX.length;
  let total = 0;
  let worst = 0;
  for (let s = 0; s < segments; s++) {
    const t = turn(track, s, (s + 1) % segments);
    total += t;
    worst = Math.max(worst, Math.abs(t));
  }
  // One lap, not one lap plus a loop round every roundabout (998° before).
  expect(total).toBeCloseTo(360, 3);
  expect(worst).toBeLessThan(4.5);
});

test("the viaduct closes on itself and stays on the ring's own vertices", () => {
  const ring = octagon(10);
  const points = metroTrackPoints(ring, 2.2);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  expect(first).toEqual(last);
  expect(points.every(([, y]) => y === 2.2)).toBe(true);
  // Rounded corners cut inside the polygon, never outside it.
  expect(Math.max(...points.map(([x, , z]) => Math.hypot(x, z)))).toBeLessThanOrEqual(10 + 1e-9);
});

test("a degenerate ring has no track rather than a broken one", () => {
  expect(buildMetroTrack([])).toBeNull();
  expect(
    buildMetroTrack([
      [0, 0],
      [1, 0],
    ]),
  ).toBeNull();
});
