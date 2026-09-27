import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BackSide, Mesh, Scene, SphereGeometry } from "three";
import { max, mix, positionLocal, smoothstep } from "three/tsl";
import { MeshBasicNodeMaterial, type Node, PMREMGenerator } from "three/webgpu";
import { gpuRenderer } from "./lighting/renderer";
import { type LightingRuntime, useLighting } from "./lighting/runtime";
import { NO_RAYCAST } from "./three/instancing";

/** Shared linear radiance for the visible sky, IBL and the water's analytic reflection. */
export function skyRadiance(direction: Node<"vec3">, light: LightingRuntime) {
  const up = max(direction.y, 0);
  const down = max(direction.y.negate(), 0);
  const sky = mix(light.horizon, light.zenith, up.pow(0.55));
  const base = mix(sky, light.ground, down.pow(0.4));
  const alignment = max(direction.dot(light.sunDirection), 0);
  const disc = smoothstep(0.99993, 0.99998, alignment);
  const halo = alignment.pow(32).mul(0.045);
  return base.add(light.sunColor.mul(disc.mul(3).add(halo)).mul(light.sunPower));
}

export function SkyEnvironment() {
  const renderer = gpuRenderer(useThree((s) => s.gl));
  const scene = useThree((s) => s.scene);
  const light = useLighting();
  const resources = useMemo(() => {
    const geometry = new SphereGeometry(1, 32, 16);
    const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
    material.colorNode = skyRadiance(positionLocal.normalize(), light);
    const sky = new Mesh(geometry, material);
    sky.frustumCulled = false;
    sky.renderOrder = -100;
    sky.raycast = NO_RAYCAST;
    const source = new Scene();
    source.add(new Mesh(geometry, material));
    return {
      sky,
      source,
      material,
      geometry,
      pmrem: new PMREMGenerator(renderer),
      target: null as ReturnType<PMREMGenerator["fromScene"]> | null,
      lastBake: -Infinity,
      instantUtcMs: Number.NaN,
      revision: -1,
    };
  }, [renderer, light]);
  useEffect(
    () => () => {
      if (scene.environment === resources.target?.texture) {
        scene.environment = null;
      }
      resources.target?.dispose();
      resources.pmrem.dispose();
      resources.geometry.dispose();
      resources.material.dispose();
    },
    [resources, scene],
  );
  useFrame(({ camera }) => {
    resources.sky.position.copy(camera.position);
    resources.sky.scale.setScalar(camera.far * 0.8);
    const now = performance.now();
    const edited = resources.revision !== light.revision;
    const timeChanged = resources.instantUtcMs !== light.solar.instantUtcMs;
    if (
      resources.target == null ||
      (edited ? now - light.lastEdit >= 250 : timeChanged && now - resources.lastBake >= 30_000)
    ) {
      // Keep the GPU texture and its bindings stable when the sky changes.
      resources.target = resources.pmrem.fromScene(resources.source, 0, 0.1, 10, {
        size: 64,
        renderTarget: resources.target,
      });
      scene.environment = resources.target.texture;
      resources.revision = light.revision;
      resources.instantUtcMs = light.solar.instantUtcMs;
      resources.lastBake = now;
      light.environmentBakes++;
    }
  }, -40);
  return <primitive object={resources.sky} />;
}
