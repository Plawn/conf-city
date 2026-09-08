import { expect, test } from "bun:test";
import {
  buildStationAccess,
  buildStationAccesses,
  headingOnAccess,
  PLATFORM_OFFSET,
  PLATFORM_TOP,
  placeOnAccess,
  STREET_OFFSET,
  STREET_Y,
} from "./station";
import { buildTrajectory, createPose } from "./trajectory";

function circle(radius = 8) {
  return buildTrajectory(
    Array.from({ length: 129 }, (_, i) => {
      const a = (i / 128) * Math.PI * 2;
      return [Math.cos(a) * radius, 2.2, Math.sin(a) * radius] as [number, number, number];
    }),
    true,
  )!;
}

test("an access runs from the street up to the platform", () => {
  const access = buildStationAccess(circle(), [0, 0], 0)!;
  expect(access).not.toBeNull();
  expect(access.street[1]).toBeCloseTo(STREET_Y, 7);
  expect(access.stairFoot[1]).toBeCloseTo(STREET_Y, 7);
  expect(access.stairTop[1]).toBeCloseTo(PLATFORM_TOP, 7);
  expect(access.door[1]).toBeCloseTo(PLATFORM_TOP, 7);
  expect(access.walk.total).toBeGreaterThan(STREET_OFFSET - PLATFORM_OFFSET);
});

test("everything is laid inward, never over the water", () => {
  const access = buildStationAccess(circle(), [0, 0], 1)!;
  const radius = (p: [number, number, number]) => Math.hypot(p[0], p[2]);
  expect(radius(access.track)).toBeCloseTo(8, 2);
  expect(radius(access.door)).toBeCloseTo(8 - PLATFORM_OFFSET, 2);
  expect(radius(access.street)).toBeCloseTo(8 - STREET_OFFSET, 2);
  expect(radius(access.street)).toBeLessThan(radius(access.track));
});

test("the walk never descends and stays inside its own length", () => {
  const access = buildStationAccess(circle(), [0, 0], 2)!;
  const pose = createPose();
  let previous = -1;
  for (let d = 0; d <= access.walk.total; d += 0.05) {
    placeOnAccess(access, d, 0, pose);
    expect(pose.y).toBeGreaterThanOrEqual(previous - 1e-9);
    previous = pose.y;
  }
  placeOnAccess(access, -5, 0, pose);
  expect(pose.y).toBeCloseTo(STREET_Y, 7);
  placeOnAccess(access, access.walk.total + 5, 0, pose);
  expect(pose.y).toBeCloseTo(PLATFORM_TOP, 7);
});

test("a lateral offset spreads people sideways, not along the walk", () => {
  const access = buildStationAccess(circle(), [0, 0], 0)!;
  const middle = createPose();
  const aside = createPose();
  placeOnAccess(access, access.walk.total, 0, middle);
  placeOnAccess(access, access.walk.total, 0.6, aside);
  expect(Math.hypot(aside.x - middle.x, aside.z - middle.z)).toBeCloseTo(0.6, 6);
  expect(aside.y).toBeCloseTo(middle.y, 7);
});

test("everyone on the access looks outward, toward the track", () => {
  const access = buildStationAccess(circle(), [0, 0], 0)!;
  const pose = createPose();
  placeOnAccess(access, access.walk.total, 0, pose);
  const waiting = headingOnAccess(access, access.walk.total, pose);
  expect(Math.sin(waiting)).toBeCloseTo(-access.inX, 6);
  expect(Math.cos(waiting)).toBeCloseTo(-access.inZ, 6);
  placeOnAccess(access, 0.2, 0, pose);
  expect(headingOnAccess(access, 0.2, pose)).toBeCloseTo(waiting, 6);
});

test("three stations, and none at all on a degenerate ring", () => {
  const accesses = buildStationAccesses(circle(), [0, 0]);
  expect(accesses.map((a) => a.index)).toEqual([0, 1, 2]);
  expect(buildStationAccesses(circle(0.0001), [0, 0])).toEqual([]);
});
