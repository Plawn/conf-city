import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AmbientLight, Box3, Color, DirectionalLight, Fog, Matrix4, Vector3 } from "three";
import { computeSolarState, resolveSolarInstant } from "../../domain/solar";
import { useLightingStore } from "../../store/lightingStore";
import { useQualityProfile } from "../../store/uiStore";
import { renderParams } from "./renderer";
import { useLighting } from "./runtime";
import { nightGate } from "./selection";
import {
  fitShadowBounds,
  frustumCorners,
  regionNeedsRefit,
  ShadowBoundsCache,
  type ShadowFit,
} from "./shadowBounds";
import { ShadowRefreshPolicy } from "./shadowRefresh";

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
  const shadowsEnabled = renderParams.get("shadows") !== "0";
  const { sun, ambient, bounds, boundsCache, center, size, scratch } = useMemo(() => {
    const sun = new DirectionalLight(0xffffff, 0);
    sun.shadow.camera.name = "Sun shadow";
    sun.castShadow = shadowsEnabled;
    sun.shadow.autoUpdate = false;
    // Render before anything samples the map: Three r185 never refreshes bind groups
    // of a shadow texture that was first bound as a sample and then recreated as a target.
    sun.shadow.needsUpdate = shadowsEnabled;
    // VSM: no depth compare, so no constant bias; `radius` is the blur in texels.
    sun.shadow.bias = 0;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    sun.shadow.blurSamples = 8;
    return {
      sun,
      ambient: new AmbientLight(0xffffff, 0.2),
      bounds: new Box3(),
      boundsCache: new ShadowBoundsCache(),
      center: new Vector3(),
      size: new Vector3(),
      scratch: {
        lightView: new Matrix4(),
        projectionInverse: new Matrix4(),
        corners: [] as Vector3[],
        eye: new Vector3(),
        corner: new Vector3(),
      },
    };
  }, [shadowsEnabled]);
  useEffect(() => () => sun.dispose(), [sun]);
  const timing = useMemo(
    () => ({
      nextBounds: 0,
      policy: new ShadowRefreshPolicy(1),
      fit: null as ShadowFit | null,
      candidate: null as ShadowFit | null,
      boundsMutated: false,
      viewMoved: false,
      settingsPending: false,
    }),
    [],
  );
  useEffect(() => {
    // `ShadowNode` sizes its map from `mapSize` on every render: a runtime change is safe.
    sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    timing.policy.setHz(profile.shadowHz);
    timing.policy.invalidate();
    timing.fit = null;
    timing.nextBounds = 0;
  }, [sun, timing, profile.shadowMapSize, profile.shadowHz]);

  // Shading follows the sun now; the shadow camera only follows at render time.
  const placeSun = () => {
    const direction = runtime.sunDirection.value;
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(direction, bounds.getSize(size).length() + 20);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    // Keep an orthonormal basis even at the zenith.
    sun.shadow.camera.up.set(
      0,
      Math.abs(direction.y) > 0.99 ? 0 : 1,
      Math.abs(direction.y) > 0.99 ? 1 : 0,
    );
  };
  useFrame(({ clock, camera }) => {
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
      placeSun();
      ambient.intensity = solar.ambientIntensity;
      scene.environmentIntensity = solar.environmentIntensity;
      if (scene.fog instanceof Fog) {
        scene.fog.color.copy(runtime.horizon.value);
      }
    }
    // Day/night gate shared with `LocalLighting`; `castShadow` itself never flips at runtime.
    runtime.nightLights = nightGate(runtime.nightLights, runtime.solar.night);
    const t = clock.elapsedTime;
    const direction = runtime.sunDirection.value;
    // Candidate fit at the tier's cadence; the map only renders when the policy says so.
    if (changed || t >= timing.nextBounds) {
      timing.nextBounds = t + 1 / profile.shadowHz;
      timing.boundsMutated = boundsCache.collect(scene, bounds) || timing.boundsMutated;
      if (bounds.isEmpty()) {
        bounds.set(new Vector3(-extent, 0, -extent), new Vector3(extent, 12, extent));
      }
      bounds.max.y = Math.max(bounds.max.y, 12);
      bounds.min.y = Math.min(bounds.min.y, -1);
      bounds.expandByScalar(6);
      bounds.getCenter(center);
      placeSun();
      const { lightView, projectionInverse, corners, eye, corner } = scratch;
      lightView
        .lookAt(sun.position, center, sun.shadow.camera.up)
        .setPosition(sun.position)
        .invert();
      camera.updateMatrixWorld();
      projectionInverse.copy(camera.projectionMatrix).invert();
      camera.getWorldPosition(eye);
      let reach = 0;
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          reach = Math.max(reach, corner.set(x, 0, z).distanceTo(eye));
        }
      }
      frustumCorners(projectionInverse, camera.matrixWorld, reach, corners);
      timing.candidate = fitShadowBounds(bounds, lightView, profile.shadowMapSize, corners);
      timing.viewMoved = timing.viewMoved || regionNeedsRefit(timing.fit, timing.candidate.region);
    }
    timing.settingsPending = timing.settingsPending || changed;
    const fit = timing.candidate;
    if (!fit) {
      return;
    }
    const reason = timing.policy.decide({
      time: t,
      settingsChanged: timing.settingsPending,
      sunDirection: direction,
      sunIntensity: shadowsEnabled ? sun.intensity : 0,
      worldTexel: (fit.right - fit.left) / profile.shadowMapSize,
      boundsMutated: timing.boundsMutated,
      // Last frame's writes: `BuildingAnimations` resets the counter after this hook.
      buildingWrites: runtime.frameWork.buildingInstanceWrites,
      viewMoved: timing.viewMoved,
    });
    timing.boundsMutated = false;
    timing.viewMoved = false;
    if (!reason) {
      return;
    }
    timing.settingsPending = false;
    sun.shadow.updateMatrices(sun);
    const { region: _region, ...frustum } = fit;
    Object.assign(sun.shadow.camera, frustum);
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
    runtime.frameWork.sunShadowRenders++;
    timing.fit = fit;
  }, -50);
  return (
    <>
      <primitive object={sun} />
      <primitive object={sun.target} />
      <primitive object={ambient} />
    </>
  );
}
