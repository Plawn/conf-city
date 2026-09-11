import { expect, spyOn, test } from "bun:test";
import { Box3, BoxGeometry, Euler, Group, Matrix4, Mesh, Quaternion, Vector3 } from "three";
import { PARIS } from "../../domain/solar";
import { readSolarLocation, useLightingStore } from "../../store/lightingStore";
import { createSim } from "../traffic/sim";
import { createBeaconGeometry } from "./beaconGeometry";
import { createLightingRuntime } from "./runtime";
import { BrakeTracker, headlightSplit, nightGate, selectLights } from "./selection";
import {
  fitShadowBounds,
  frustumCorners,
  regionNeedsRefit,
  ShadowBoundsCache,
} from "./shadowBounds";
import { createVehicleLights } from "./VehicleLights";

test("solar storage validates data and tolerates unavailable storage", () => {
  expect(readSolarLocation({ getItem: () => "broken" })).toEqual(PARIS);
  expect(
    readSolarLocation({
      getItem: () => {
        throw new Error("denied");
      },
    }),
  ).toEqual(PARIS);
  expect(readSolarLocation({ getItem: () => JSON.stringify({ ...PARIS, latitude: 900 }) })).toEqual(
    PARIS,
  );
  const tokyo = { latitude: 35.67, longitude: 139.65, timeZone: "Asia/Tokyo" };
  expect(readSolarLocation({ getItem: () => JSON.stringify(tokyo) })).toEqual(tokyo);
});

test("preview and live transitions increment the immediate lighting revision", () => {
  const revision = useLightingStore.getState().revision;
  useLightingStore.getState().preview(1000);
  expect(useLightingStore.getState().clock).toEqual({ mode: "preview", instantUtcMs: 1000 });
  useLightingStore.getState().live();
  expect(useLightingStore.getState().revision).toBe(revision + 2);
  expect(useLightingStore.getState().clock.mode).toBe("live");
});

test("shadow camera encloses tall casters and receivers even with grazing sun", () => {
  const bounds = new Box3(new Vector3(-70, -1, -50), new Vector3(110, 45, 65));
  for (const direction of [
    new Vector3(1, 0.001, 0.3),
    new Vector3(0, 1, 0),
    new Vector3(-1, 0.6, 1),
  ]) {
    const eye = direction.normalize().multiplyScalar(500);
    const world = new Matrix4().lookAt(eye, new Vector3(), new Vector3(0, 0, 1)).setPosition(eye);
    const view = world.invert();
    const fit = fitShadowBounds(bounds, view);
    for (const x of [-70, 110]) {
      for (const y of [-1, 45]) {
        for (const z of [-50, 65]) {
          const p = new Vector3(x, y, z).applyMatrix4(view);
          expect(p.x).toBeGreaterThan(fit.left);
          expect(p.x).toBeLessThan(fit.right);
          expect(p.y).toBeGreaterThan(fit.bottom);
          expect(p.y).toBeLessThan(fit.top);
          expect(-p.z).toBeGreaterThan(fit.near);
          expect(-p.z).toBeLessThan(fit.far);
        }
      }
    }
  }
});

test("shadow center is stable for subtexel translations", () => {
  const bounds = new Box3(new Vector3(-10, -10, -40), new Vector3(10, 10, -20));
  const { region: _a, ...a } = fitShadowBounds(bounds, new Matrix4());
  const { region: _b, ...b } = fitShadowBounds(
    bounds.clone().translate(new Vector3(0.001, 0.001, 0)),
    new Matrix4(),
  );
  expect(a).toEqual(b);
});

test("beacon starts at the lamp and widens along the spotlight's positive Z axis", () => {
  for (const open of [true, false]) {
    const geometry = createBeaconGeometry(1.5, 16, open);
    const positions = geometry.attributes.position!;
    let tips = 0;
    let rim = 0;
    for (let i = 0; i < positions.count; i++) {
      const radius = Math.hypot(positions.getX(i), positions.getY(i));
      if (Math.abs(positions.getZ(i)) < 1e-6) {
        expect(radius).toBeLessThan(1e-6);
        tips++;
      }
      if (radius > 1) {
        expect(positions.getZ(i)).toBeCloseTo(16);
        expect(radius).toBeCloseTo(1.5);
        rim++;
      }
    }
    expect(tips).toBeGreaterThan(0);
    expect(rim).toBeGreaterThan(0);
    geometry.dispose();
  }
});

test("shadow bounds reuse static transforms and follow growth, visibility and late meshes", () => {
  const scene = new Group();
  const group = new Group();
  group.position.x = 10;
  scene.add(group);
  const geometry = new BoxGeometry(2, 2, 2);
  const mesh = new Mesh(geometry);
  mesh.castShadow = true;
  group.add(mesh);
  scene.updateMatrixWorld();
  const cache = new ShadowBoundsCache();
  const bounds = new Box3();
  expect(cache.collect(scene, bounds)).toBe(true);
  expect(bounds.min.toArray()).toEqual([9, -1, -1]);
  expect(bounds.max.toArray()).toEqual([11, 1, 1]);

  const apply = spyOn(Box3.prototype, "applyMatrix4");
  try {
    expect(cache.collect(scene, bounds)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    mesh.scale.y = 5;
    scene.updateMatrixWorld();
    expect(cache.collect(scene, bounds)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(bounds.max.y).toBe(5);
  } finally {
    apply.mockRestore();
  }
  group.visible = false;
  expect(cache.collect(scene, bounds)).toBe(true);
  expect(bounds.isEmpty()).toBe(true);
  expect(cache.collect(scene, bounds)).toBe(false);
  group.visible = true;
  const late = new Mesh(geometry);
  late.receiveShadow = true;
  late.position.z = 20;
  scene.add(late);
  scene.updateMatrixWorld();
  expect(cache.collect(scene, bounds)).toBe(true);
  expect(bounds.max.z).toBe(21);
  late.removeFromParent();
  expect(cache.collect(scene, bounds)).toBe(true);
  expect(bounds.max.z).toBe(1);
  const replacement = new BoxGeometry(4, 4, 4);
  mesh.geometry = replacement;
  expect(cache.collect(scene, bounds)).toBe(true);
  expect(bounds.max.y).toBe(10);
  geometry.dispose();
  replacement.dispose();
});

test("shadow fit narrows to the framed view and keeps the world fit otherwise", () => {
  const bounds = new Box3(new Vector3(-200, -1, -200), new Vector3(200, 30, 200));
  const lightView = new Matrix4()
    .lookAt(new Vector3(100, 300, 200), new Vector3(), new Vector3(0, 1, 0))
    .setPosition(new Vector3(100, 300, 200))
    .invert();
  const world = fitShadowBounds(bounds, lightView, 2048);
  const closeUp = [
    new Vector3(-10, 0, -10),
    new Vector3(10, 0, -10),
    new Vector3(-10, 0, 10),
    new Vector3(10, 0, 10),
    new Vector3(-12, 20, -12),
    new Vector3(12, 20, 12),
  ];
  const zoomed = fitShadowBounds(bounds, lightView, 2048, closeUp);
  expect(zoomed.left).toBeGreaterThan(world.left);
  expect(zoomed.right).toBeLessThan(world.right);
  expect(zoomed.bottom).toBeGreaterThan(world.bottom);
  expect(zoomed.top).toBeLessThan(world.top);
  expect(zoomed.near).toBe(world.near);
  expect(zoomed.far).toBe(world.far);
  for (const point of closeUp) {
    const p = point.clone().applyMatrix4(lightView);
    expect(p.x).toBeGreaterThan(zoomed.left + 4);
    expect(p.x).toBeLessThan(zoomed.right - 4);
    expect(p.y).toBeGreaterThan(zoomed.bottom + 4);
    expect(p.y).toBeLessThan(zoomed.top - 4);
  }
  const everything = [new Vector3(-900, -50, -900), new Vector3(900, 200, 900)];
  const { region: _r, ...framedAll } = fitShadowBounds(bounds, lightView, 2048, everything);
  const { region: _w, ...worldOnly } = world;
  expect(framedAll).toEqual(worldOnly);
  const outside = [new Vector3(500, 0, 500), new Vector3(600, 0, 600)];
  const { region: _o, ...missed } = fitShadowBounds(bounds, lightView, 2048, outside);
  expect(missed).toEqual(worldOnly);
});

test("view region refits only when uncovered or much smaller", () => {
  const fit = {
    left: -100,
    right: 100,
    bottom: -50,
    top: 50,
    near: 1,
    far: 10,
    region: { minX: -90, maxX: 90, minY: -40, maxY: 40 },
  };
  expect(regionNeedsRefit(null, fit.region)).toBe(true);
  expect(regionNeedsRefit(fit, { minX: -60, maxX: 60, minY: -30, maxY: 30 })).toBe(false);
  expect(regionNeedsRefit(fit, { minX: -60, maxX: 120, minY: -30, maxY: 30 })).toBe(true);
  expect(regionNeedsRefit(fit, { minX: -20, maxX: 20, minY: -10, maxY: 10 })).toBe(true);
});

test("frustum corners are pulled in to the reach distance", () => {
  const eye = new Vector3(0, 50, 100);
  const cameraWorld = new Matrix4()
    .lookAt(eye, new Vector3(), new Vector3(0, 1, 0))
    .setPosition(eye);
  const projection = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 5000);
  const corners = frustumCorners(projection.clone().invert(), cameraWorld, 300, []);
  expect(corners).toHaveLength(8);
  for (const corner of corners.slice(0, 4)) {
    expect(corner.distanceTo(eye)).toBeCloseTo(Math.sqrt(3), 3);
  }
  for (const corner of corners.slice(4)) {
    expect(corner.distanceTo(eye)).toBeCloseTo(300, 3);
  }
  const reused = frustumCorners(projection.clone().invert(), cameraWorld, 300, corners);
  expect(reused).toBe(corners);
});

test("night gate has hysteresis around dusk", () => {
  expect(nightGate(false, 0)).toBe(false);
  expect(nightGate(false, 0.02)).toBe(false);
  expect(nightGate(false, 0.05)).toBe(true);
  expect(nightGate(true, 0.02)).toBe(true);
  expect(nightGate(true, 0.01)).toBe(true);
  expect(nightGate(true, 0.005)).toBe(false);
  expect(nightGate(true, 1)).toBe(true);
});

test("shadow bounds do not recursively include excluded children of a mesh", () => {
  const geometry = new BoxGeometry(2, 2, 2);
  const parent = new Mesh(geometry);
  parent.castShadow = true;
  const child = new Mesh(geometry);
  child.receiveShadow = true;
  child.userData.excludeSunBounds = true;
  child.position.x = 1000;
  parent.add(child);
  parent.updateMatrixWorld();
  const bounds = new Box3();
  new ShadowBoundsCache().collect(parent, bounds);
  expect(bounds.max.x).toBe(1);
  geometry.dispose();
});

test("light selection has hysteresis, capacity and deterministic tie breaks", () => {
  expect(
    selectLights(
      [
        { id: "a", score: 1 },
        { id: "b", score: 1.1 },
      ],
      new Set(["a"]),
      1,
    ),
  ).toEqual(["a"]);
  expect(
    selectLights(
      [
        { id: "a", score: 1 },
        { id: "b", score: 2 },
      ],
      new Set(["a"]),
      1,
    ),
  ).toEqual(["b"]);
  expect(
    selectLights(
      [
        { id: "b", score: 1 },
        { id: "a", score: 1 },
        { id: "nan", score: Number.NaN },
      ],
      new Set(),
      2,
    ),
  ).toEqual(["a", "b"]);
});

test("braking follows stable IDs across swaps and expires after removal", () => {
  const tracker = new BrakeTracker();
  expect(tracker.update(1, 1, 0.1)).toBe(0);
  expect(tracker.update(2, 0.3, 0.1)).toBe(0);
  expect(tracker.update(2, 0.3, 0.1)).toBe(0);
  expect(tracker.update(1, 0.5, 0.1)).toBe(1);
  tracker.retain(new Set([2]));
  expect(tracker.size).toBe(1);
  expect(tracker.update(3, 0.1, 0.1)).toBe(0);
});

test("vehicle projectors follow pitch/roll and release sources on pool recycling and disposal", () => {
  const runtime = createLightingRuntime();
  const lights = createVehicleLights(2, 1.4, "trucks", runtime);
  const pool = createSim([], 2, 1).cars;
  const q = new Quaternion().setFromEuler(new Euler(0.2, 0.7, -0.1));
  pool.count = 1;
  pool.id[0] = 42;
  pool.opacity[0] = 1;
  pool.x[0] = 10;
  pool.y[0] = 3;
  pool.z[0] = -4;
  [pool.qx[0], pool.qy[0], pool.qz[0], pool.qw[0]] = q.toArray();
  lights.update(pool, 1 / 30);
  const source = runtime.sources.get("trucks:42")!;
  const expected = new Vector3(0, 0.1, 0.28)
    .multiplyScalar(1.4)
    .applyQuaternion(q)
    .add(new Vector3(10, 3, -4));
  expect(source.position.distanceTo(expected)).toBeLessThan(1e-6);
  expect(
    source.direction.distanceTo(new Vector3(0, -0.12, 1).applyQuaternion(q).normalize()),
  ).toBeLessThan(1e-6);
  // The pair offset is the bulb offset rotated with the body, scaled like the projector.
  expect(source.lateral.distanceTo(new Vector3(0.092 * 1.4, 0, 0).applyQuaternion(q))).toBeLessThan(
    1e-6,
  );
  pool.id[0] = 99;
  lights.update(pool, 1 / 30);
  expect(runtime.sources.has("trucks:42")).toBe(false);
  expect(runtime.sources.has("trucks:99")).toBe(true);
  pool.count = 0;
  lights.update(pool, 1 / 30);
  expect(runtime.sources.size).toBe(0);
  pool.count = 1;
  lights.update(pool, 1 / 30);
  lights.dispose();
  expect(runtime.sources.size).toBe(0);
});

test("headlight pairs split near the camera with hysteresis between 12 and 16 units", () => {
  expect(headlightSplit(false, 143)).toBe(true);
  expect(headlightSplit(false, 144)).toBe(false);
  expect(headlightSplit(false, 200)).toBe(false);
  expect(headlightSplit(true, 200)).toBe(true);
  expect(headlightSplit(true, 256)).toBe(true);
  expect(headlightSplit(true, 257)).toBe(false);
  expect(headlightSplit(false, 257)).toBe(false);
});
