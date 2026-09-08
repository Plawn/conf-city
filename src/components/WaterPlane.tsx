import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, Vector4 } from "three";
import {
  cameraPosition,
  cameraViewMatrix,
  cos,
  float,
  mix,
  positionWorld,
  reflect,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { TERRAIN } from "../domain/nodeStyle";
import type { ShoreField } from "../layout/shore";
import { useLighting } from "./lighting/runtime";
import { skyRadiance } from "./SkyEnvironment";
import { rippleTexture, shoreTexture } from "./water/textures";

const OPEN_SEA: ShoreField = {
  size: 1,
  originX: 0,
  originZ: 0,
  cell: 1,
  reach: 1,
  data: new Uint8Array([255]),
};

/** Same shoreline and wave model, expressed in TSL for both WebGPU and WebGL backends. */
export function WaterPlane({ size = 600, shore }: { size?: number; shore?: ShoreField }) {
  const light = useLighting();
  const resources = useMemo(() => {
    const field = shore ?? OPEN_SEA;
    const coast = shoreTexture(field);
    const ripple = rippleTexture();
    const flow = uniform(new Vector4());
    const waves = uniform(new Vector4());
    const p = positionWorld.xz;
    const coastUv = p
      .sub(vec2(field.originX, field.originZ))
      .div(field.cell)
      .add(0.5)
      .div(field.size);
    const distance = texture(coast, coastUv).r;
    const r1 = texture(ripple, p.mul(0.085).add(flow.xy)).rgb.mul(2).sub(1);
    const r2 = texture(ripple, p.mul(0.21).add(flow.zw)).rgb.mul(2).sub(1);
    const rim = float(1).sub(smoothstep(0.01, 0.055, distance));
    const phase = distance.mul(15).add(waves.w).add(r1.b.mul(3));
    const foam = rim
      .mul(
        smoothstep(-0.25, 0.55, r2.b.add(r1.b.mul(0.4)))
          .mul(0.3)
          .add(0.18),
      )
      .add(
        smoothstep(0.68, 0.98, sin(phase))
          .mul(float(1).sub(smoothstep(0.08, 0.5, distance)))
          .mul(0.35),
      )
      .clamp(0, 0.65);
    const sx = cos(p.x.mul(0.09).add(waves.x))
      .mul(0.55)
      .add(cos(p.dot(vec2(0.05, 0.043)).add(waves.z)).mul(0.265));
    const sz = cos(p.y.mul(0.07).sub(waves.y))
      .mul(0.45)
      .add(cos(p.dot(vec2(0.05, 0.043)).add(waves.z)).mul(0.228));
    const rippleAmp = float(1)
      .sub(smoothstep(50, 220, cameraPosition.sub(positionWorld).length()))
      .mul(0.12);
    const tilt = vec2(sx, sz)
      .mul(0.085)
      .add(r1.rg.add(r2.rg.mul(0.6)).mul(rippleAmp));
    const normal = vec3(tilt.x.negate(), 1, tilt.y.negate()).normalize();
    const view = cameraPosition.sub(positionWorld).normalize();
    const reflected = reflect(view.negate(), normal);
    const fresnel = float(1).sub(normal.dot(view).clamp(0, 1)).pow(5).mul(0.32);
    const material = new MeshStandardNodeMaterial({
      color: TERRAIN.waterColor,
      metalness: 0.15,
      roughness: 0.3,
    });
    material.colorNode = mix(
      mix(
        uniform(new Color(TERRAIN.waterShallow)),
        uniform(new Color(TERRAIN.waterColor)).mul(r1.b.mul(0.08).add(1)),
        smoothstep(0, 1, distance),
      ),
      uniform(new Color(TERRAIN.waterFoam)),
      foam,
    );
    material.normalNode = cameraViewMatrix.mul(vec4(normal, 0)).xyz.normalize();
    material.roughnessNode = mix(0.3, 0.7, foam);
    material.emissiveNode = skyRadiance(reflected, light)
      .mul(fresnel)
      .mul(float(1).sub(foam))
      .add(uniform(new Color(TERRAIN.waterFoam)).mul(foam).mul(0.03));
    return { material, coast, flow, waves };
  }, [shore, light]);
  useEffect(
    () => () => {
      resources.material.dispose();
      resources.coast.dispose();
    },
    [resources],
  );
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const tau = Math.PI * 2;
    resources.flow.value.set((t * 0.008) % 1, (t * 0.005) % 1, (-t * 0.006) % 1, (t * 0.009) % 1);
    resources.waves.value.set(
      (t * 0.33) % tau,
      (t * 0.24) % tau,
      (t * 0.17) % tau,
      (t * 0.8) % tau,
    );
  });
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position-y={TERRAIN.waterY}
      material={resources.material}
      receiveShadow
      userData={{ excludeSunBounds: true }}
    >
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}
