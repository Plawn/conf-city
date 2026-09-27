import { expect, test } from "bun:test";
import { DirectionalLight, NodeFrame, PointLight, SpotLight } from "three/webgpu";
import { ActiveClusteredLightsNode } from "@/components/lighting/ActiveClusteredLighting";
import { gatePass } from "@/components/lighting/passGate";
import { LightCandidates, selectLights } from "@/components/lighting/selection";

test("clusters drop only zero-intensity points and restore fading lights without changing material lights", () => {
  const node = new ActiveClusteredLightsNode();
  const point = new PointLight(0xffffff, 0);
  const fading = new PointLight(0xffffff, 0.000001);
  const spot = new SpotLight(0xffffff, 0);
  const sun = new DirectionalLight();
  const shadowed = new PointLight(0xffffff, 0);
  shadowed.castShadow = true;
  const lights = [point, fading, spot, sun, shadowed];
  node.setLights(lights);
  const materialKey = node.customCacheKey();
  expect(node.clusteredLights).toEqual([fading]);
  expect(node.materialLights).toEqual([spot, sun, shadowed]);
  expect(node.getLights()).toBe(lights);
  point.intensity = 1;
  node.setLights(lights);
  expect(node.clusteredLights).toEqual([point, fading]);
  expect(node.customCacheKey()).toBe(materialKey);
  // Simulate the renderer's nested volume pass and restoration of the main light list.
  node.setLights([spot]);
  expect(node.clusteredLights).toEqual([]);
  node.setLights(lights);
  expect(node.clusteredLights).toEqual([point, fading]);
  point.intensity = 0;
  fading.intensity = 0;
  node.setLights(lights);
  expect(node.clusteredLights).toEqual([]);
  expect(lights).toHaveLength(5);
});

test("opted-in shadowless spots cluster, compact at zero intensity and keep the material key", () => {
  const node = new ActiveClusteredLightsNode();
  const point = new PointLight(0xffffff, 1);
  const marked = new SpotLight(0xffffff, 1, 6);
  marked.userData.clustered = true;
  const merged = new SpotLight(0xffffff, 0, 6);
  merged.userData.clustered = true;
  const beacon = new SpotLight(0xffffff, 1, 6);
  const shadowed = new SpotLight(0xffffff, 1, 6);
  shadowed.userData.clustered = true;
  shadowed.castShadow = true;
  const infinite = new SpotLight(0xffffff, 1, 0);
  infinite.userData.clustered = true;
  const sun = new DirectionalLight();
  node.work = { dispatches: 0, pointLightVisits: 0, spotLightVisits: 0 };
  const materialOnly = [point, beacon, shadowed, infinite, sun];
  node.setLights(materialOnly);
  const materialKey = node.customCacheKey();
  node.setLights([point, marked, merged, beacon, shadowed, infinite, sun]);
  expect(node.clusteredLights).toEqual([point, marked]);
  expect(node.materialLights).toEqual([beacon, shadowed, infinite, sun]);
  expect(node.clusteredSpots).toBe(1);
  expect(node.customCacheKey()).toBe(materialKey);
  node.updateBefore(new NodeFrame());
  merged.intensity = 0.5;
  node.setLights([point, marked, merged, beacon, shadowed, infinite, sun]);
  expect(node.clusteredLights).toEqual([point, marked, merged]);
  node.updateBefore(new NodeFrame());
  expect(node.work).toEqual({ dispatches: 2, pointLightVisits: 2, spotLightVisits: 3 });
  node.setLights(materialOnly);
  expect(node.clusteredSpots).toBe(0);
  expect(node.customCacheKey()).toBe(materialKey);
});

test("suspended volume clears once, blur consumes black once, and both resume immediately", () => {
  let active = false;
  let image = "uninitialized";
  let output = "uninitialized";
  let volumeUpdates = 0;
  let blurUpdates = 0;
  let clears = 0;
  const volume = {
    updateBefore: () => {
      image = "beam";
      return undefined;
    },
  };
  const blur = {
    updateBefore: () => {
      output = image;
      return undefined;
    },
  };
  gatePass(
    volume,
    () => active,
    () => volumeUpdates++,
    () => {
      image = "black";
      clears++;
    },
  );
  gatePass(
    blur,
    () => active,
    () => blurUpdates++,
  );
  const tick = () => {
    volume.updateBefore();
    blur.updateBefore();
  };
  tick();
  tick();
  expect(output).toBe("black");
  expect([volumeUpdates, blurUpdates, clears]).toEqual([0, 1, 1]);
  active = true;
  tick();
  expect(output).toBe("beam");
  active = false;
  tick();
  tick();
  expect(output).toBe("black");
  expect([volumeUpdates, blurUpdates, clears]).toEqual([1, 3, 2]);
  active = true;
  tick();
  expect(output).toBe("beam");
});

test("a failed clear is retried instead of caching stale output", () => {
  let attempts = 0;
  const node = { updateBefore: (_frame: NodeFrame): undefined => undefined };
  gatePass(
    node,
    () => false,
    () => {},
    () => {
      if (++attempts === 1) {
        throw new Error("device lost");
      }
    },
  );
  expect(() => node.updateBefore(new NodeFrame())).toThrow("device lost");
  node.updateBefore(new NodeFrame());
  node.updateBefore(new NodeFrame());
  expect(attempts).toBe(2);
});

test("reused light candidates preserve ranking across shrinking populations and hysteresis", () => {
  const candidates = new LightCandidates();
  const selected = new Set<string>();
  const previous = new Set(["a"]);
  for (const batch of [
    [
      { id: "b", score: 1.1 },
      { id: "a", score: 1 },
      { id: "nan", score: NaN },
    ],
    [{ id: "c", score: 4 }],
    [],
    [
      { id: "b", score: 2 },
      { id: "a", score: 2 },
    ],
  ]) {
    candidates.clear();
    selected.clear();
    for (const { id, score } of batch) {
      candidates.add(id, score);
    }
    candidates.select(previous, 2, selected);
    expect([...selected]).toEqual(selectLights(batch, previous, 2));
  }
});
