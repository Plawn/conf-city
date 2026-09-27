import { expect, test } from "bun:test";
import { Matrix4, PointLight, SpotLight, Vector3 } from "three";
import {
  clusterKind,
  coneBoundingSphere,
  createBound,
  LIGHT_ROWS,
  lightBound,
  POINT_CONE_COS,
  POINT_PENUMBRA_COS,
  packLight,
  sliceRanges,
  sortByViewZ,
} from "@/components/lighting/clustered/lightPacking";

const apex = new Vector3(1, 2, 3);
const axis = new Vector3(0, 0, -1);

function rimPoint(angle: number, range: number, around: number): Vector3 {
  // A point on the far rim of the cone, rotated `around` the axis (which is -z here).
  const radial = range * Math.sin(angle);
  return new Vector3(
    apex.x + radial * Math.cos(around),
    apex.y + radial * Math.sin(around),
    apex.z - range * Math.cos(angle),
  );
}

test("cone bounding sphere holds the apex and the rim in both branches", () => {
  for (const angle of [0.32, 1.2]) {
    const bound = coneBoundingSphere(apex, axis, 4, angle, createBound());
    expect(bound.center.distanceTo(apex)).toBeLessThanOrEqual(bound.radius + 1e-9);
    for (const around of [0, 1, 2.5, 4]) {
      expect(bound.center.distanceTo(rimPoint(angle, 4, around))).toBeLessThanOrEqual(
        bound.radius + 1e-9,
      );
    }
    expect(bound.radius).toBeLessThan(4);
  }
  // Narrow cones use the sphere through apex and rim; a headlight (θ = 0.32) stays about half the range.
  const narrow = coneBoundingSphere(apex, axis, 4, 0.32, createBound());
  expect(narrow.radius).toBeCloseTo(4 / (2 * Math.cos(0.32)), 9);
  // Wide cones use the rim sphere, smaller than the apex sphere would be.
  const wide = coneBoundingSphere(apex, axis, 4, 1.2, createBound());
  expect(wide.radius).toBeCloseTo(4 * Math.sin(1.2), 9);
  // Past 90° the whole range sphere is the only safe bound.
  const back = coneBoundingSphere(apex, axis, 4, 2, createBound());
  expect(back.center.equals(apex)).toBe(true);
  expect(back.radius).toBe(4);
});

function worldSpot(distance: number, angle = 0.32): SpotLight {
  const spot = new SpotLight(0xffffff, 3, distance, angle, 0.5, 1.5);
  spot.position.set(10, 1, 0);
  spot.target.position.set(10, 1, -5);
  spot.updateMatrixWorld(true);
  spot.target.updateMatrixWorld(true);
  return spot;
}

test("light bounds use the range sphere for points and the cone sphere for spots", () => {
  const point = new PointLight(0xffffff, 1, 0);
  point.position.set(4, 5, 6);
  point.updateMatrixWorld(true);
  const bound = lightBound(point, 300, createBound());
  expect(bound.center.toArray()).toEqual([4, 5, 6]);
  expect(bound.radius).toBe(300);
  point.distance = 12;
  expect(lightBound(point, 300, createBound()).radius).toBe(12);
  const spot = lightBound(worldSpot(4), 300, createBound());
  expect(spot.radius).toBeCloseTo(4 / (2 * Math.cos(0.32)), 9);
  expect(spot.center.z).toBeCloseTo(-spot.radius, 9);
  expect(spot.center.x).toBe(10);
});

test("packing writes five rows per light with point sentinels or spot cone data", () => {
  const lineSize = 3 * 4;
  const data = new Float32Array(lineSize * LIGHT_ROWS);
  const spot = worldSpot(4);
  packLight(data, lineSize, 1, spot, lightBound(spot, 300, createBound()));
  const row = (index: number) =>
    Array.from(data.subarray(index * lineSize + 4, index * lineSize + 8));
  expect(row(1)).toEqual([10, 1, 0, 4]);
  expect(row(2)).toEqual([3, 3, 3, 1.5]);
  const direction = row(3);
  expect(direction.slice(0, 3)).toEqual([0, 0, 1]);
  expect(direction[3]).toBeCloseTo(Math.cos(0.32), 6);
  expect(row(4)[0]).toBeCloseTo(Math.cos(0.16), 6);
  const point = new PointLight(0x808080, 2, 0, 2);
  point.updateMatrixWorld(true);
  packLight(data, lineSize, 2, point, lightBound(point, 300, createBound()));
  const column = (index: number) =>
    Array.from(data.subarray(index * lineSize + 8, index * lineSize + 12));
  expect(column(0)).toEqual([0, 0, 0, 300]);
  expect(column(1)).toEqual([0, 0, 0, 0]);
  expect(column(3)).toEqual([0, 0, 1, POINT_CONE_COS]);
  expect(column(4)[0]).toBe(POINT_PENUMBRA_COS);
  // Point sentinels make smoothstep(coneCos, penumbraCos, x) saturate for any x in [-1, 1].
  expect(POINT_CONE_COS).toBeLessThan(POINT_PENUMBRA_COS);
  expect(POINT_PENUMBRA_COS).toBeLessThan(-1);
});

test("depth sort orders lights near to far and slice ranges follow each light's own radius", () => {
  const view = new Matrix4().makeTranslation(0, 0, 0);
  const bounds = [createBound(), createBound(), createBound(), createBound()];
  bounds[0]!.center.set(0, 0, -50);
  bounds[0]!.radius = 1;
  bounds[1]!.center.set(0, 0, -5);
  bounds[1]!.radius = 1;
  bounds[2]!.center.set(0, 0, -20);
  bounds[2]!.radius = 15;
  bounds[3]!.center.set(0, 0, 40);
  bounds[3]!.radius = 1;
  const viewZ = new Float32Array(4);
  const order: number[] = [];
  sortByViewZ(bounds, 4, view, viewZ, order);
  expect(order).toEqual([0, 2, 1, 3]);
  const radius = new Float32Array([1, 1, 15, 1]);
  const slices = 8;
  const out = new Float32Array(slices * 4);
  sliceRanges(viewZ, radius, order, 4, 1, 100, slices, out);
  const ranges = Array.from({ length: slices }, (_, z) => [out[z * 4], out[z * 4 + 1]]);
  // The wide sphere (z ∈ [-35, -5]) spans several slices; the light behind the camera never appears.
  const touched = ranges.filter(([start, end]) => end! > start!);
  expect(touched.length).toBeGreaterThan(2);
  for (const [, end] of ranges) {
    expect(end).toBeLessThanOrEqual(3);
  }
  // The far light (z = -50) belongs to a later slice than the near one (z = -5).
  const firstOf = (sorted: number) =>
    ranges.findIndex(([start, end]) => start! <= sorted && sorted < end!);
  expect(firstOf(0)).toBeGreaterThan(firstOf(2));
  // A count below the array length is honoured: nothing past `count` is read.
  const clamped = new Float32Array(slices * 4);
  sliceRanges(viewZ, radius, order, 2, 1, 100, slices, clamped);
  for (let z = 0; z < slices; z++) {
    expect(clamped[z * 4 + 1]).toBeLessThanOrEqual(2);
  }
});

test("only shadowless points and opted-in plain spots are clustered", () => {
  const point = new PointLight();
  expect(clusterKind(point)).toBe("point");
  point.castShadow = true;
  expect(clusterKind(point)).toBeNull();
  const spot = new SpotLight(0xffffff, 1, 4);
  expect(clusterKind(spot)).toBeNull();
  spot.userData.clustered = true;
  expect(clusterKind(spot)).toBe("spot");
  spot.castShadow = true;
  expect(clusterKind(spot)).toBeNull();
  spot.castShadow = false;
  spot.distance = 0;
  expect(clusterKind(spot)).toBeNull();
});
