import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AmbientLight, Box3, Color, DirectionalLight, Fog, Vector3 } from "three";
import { computeSolarState, resolveSolarInstant } from "../../domain/solar";
import { useLightingStore } from "../../store/lightingStore";
import { useQualityProfile } from "../../store/uiStore";
import { useLighting } from "./runtime";
import { fitShadowBounds, ShadowBoundsCache } from "./shadowBounds";

const NIGHT_ZENITH = new Color("#0a102a");
const DAY_ZENITH = new Color("#528dd4");
const NIGHT_HORIZON = new Color("#17243b");
const DAY_HORIZON = new Color("#b9d7ec");
const DUSK = new Color("#dc9874");
const WARM = new Color("#ffac58");
const WHITE = new Color("#fff4df");

export function SolarLighting({ extent }: { extent: number }) {
  const runtime = useLighting();
  const scene = useThree((s) => s.scene);
  const profile = useQualityProfile();
  const { sun, ambient, bounds, previousBounds, boundsCache, center, size } = useMemo(() => {
    const sun = new DirectionalLight(0xffffff, 0);
    sun.castShadow = true;
    sun.shadow.autoUpdate = false;
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2;
    return {
      sun,
      ambient: new AmbientLight(0xffffff, 0.2),
      bounds: new Box3(),
      previousBounds: new Box3(),
      boundsCache: new ShadowBoundsCache(),
      center: new Vector3(),
      size: new Vector3(),
    };
  }, []);
  useEffect(() => () => sun.dispose(), [sun]);
  const timing = useMemo(() => ({ nextBounds: 0, nextShadow: 0, solarInstant: Number.NaN }), []);
  useEffect(() => {
    // `ShadowNode` sizes its map from `mapSize` on every render: a runtime change is safe.
    sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    sun.shadow.needsUpdate = true;
    timing.nextBounds = 0;
    timing.nextShadow = 0;
  }, [sun, timing, profile.shadowMapSize]);

  useFrame(({ clock }) => {
    const now = Date.now();
    const settings = useLightingStore.getState();
    const changed = settings.revision !== runtime.revision;
    if (changed || (settings.clock.mode === "live" && Math.abs(now - runtime.lastWall) >= 1000)) {
      runtime.solar = computeSolarState(
        resolveSolarInstant(settings.clock, now),
        settings.location,
      );
      if (changed) {
        runtime.lastEdit = performance.now();
      }
      runtime.revision = settings.revision;
      runtime.lastWall = now;
      const solar = runtime.solar;
      runtime.sunDirection.value.set(...solar.direction);
      runtime.sunColor.value.copy(WHITE).lerp(WARM, solar.warmth);
      runtime.sunPower.value = solar.sunIntensity;
      runtime.night.value = solar.night;
      runtime.zenith.value.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, solar.day);
      runtime.horizon.value
        .copy(NIGHT_HORIZON)
        .lerp(DAY_HORIZON, solar.day)
        .lerp(DUSK, solar.warmth * solar.day * 0.65);
      runtime.ground.value.copy(runtime.horizon.value).multiplyScalar(0.16);
      sun.color.copy(runtime.sunColor.value);
      sun.intensity = solar.sunIntensity;
      ambient.intensity = solar.ambientIntensity;
      scene.environmentIntensity = solar.environmentIntensity;
      if (scene.fog instanceof Fog) {
        scene.fog.color.copy(runtime.horizon.value);
      }
    }
    // Revisit actual bounds at shadow cadence: catches late GLBs, memory-height changes and hidden cities.
    const t = clock.elapsedTime;
    if (changed || t >= timing.nextBounds) {
      timing.nextBounds = t + 1 / profile.shadowHz;
      boundsCache.collect(scene, bounds);
      if (bounds.isEmpty()) {
        bounds.set(new Vector3(-extent, 0, -extent), new Vector3(extent, 12, extent));
      }
      bounds.max.y = Math.max(bounds.max.y, 12);
      bounds.min.y = Math.min(bounds.min.y, -1);
      bounds.expandByScalar(6);
    }
    if (
      changed ||
      !bounds.equals(previousBounds) ||
      timing.solarInstant !== runtime.solar.instantUtcMs
    ) {
      previousBounds.copy(bounds);
      timing.solarInstant = runtime.solar.instantUtcMs;
      bounds.getCenter(center);
      const distance = bounds.getSize(size).length() + 20;
      sun.target.position.copy(center);
      sun.position.copy(center).addScaledVector(runtime.sunDirection.value, distance);
      sun.updateMatrixWorld();
      sun.target.updateMatrixWorld();
      // Keep an orthonormal basis even at the poles/zenith.
      sun.shadow.camera.up.set(
        0,
        Math.abs(runtime.sunDirection.value.y) > 0.99 ? 0 : 1,
        Math.abs(runtime.sunDirection.value.y) > 0.99 ? 1 : 0,
      );
      sun.shadow.updateMatrices(sun);
      Object.assign(
        sun.shadow.camera,
        fitShadowBounds(bounds, sun.shadow.camera.matrixWorldInverse, profile.shadowMapSize),
      );
      sun.shadow.camera.updateProjectionMatrix();
    }
    if (sun.intensity > 0 && (changed || t >= timing.nextShadow)) {
      sun.shadow.needsUpdate = true;
      timing.nextShadow = t + 1 / profile.shadowHz;
    }
  }, -50);
  return (
    <>
      <primitive object={sun} />
      <primitive object={sun.target} />
      <primitive object={ambient} />
    </>
  );
}
