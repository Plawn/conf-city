import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Vector4 } from "three";
import { uniform } from "three/tsl";
import { TERRAIN } from "../domain/nodeStyle";
import type { ShoreField } from "../layout/shore";
import { renderParams } from "./lighting/renderer";
import { useLighting } from "./lighting/runtime";
import { createWaterMaterial } from "./water/material";
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
    const mode = renderParams.get("water") === "reference" ? "reference" : "culled-lights";
    const material = createWaterMaterial(
      field,
      coast,
      ripple,
      flow,
      waves,
      light,
      mode !== "reference",
    );
    const referenceMaterial =
      renderParams.get("waterCompare") === "1"
        ? createWaterMaterial(field, coast, ripple, flow, waves, light)
        : null;
    return { material, referenceMaterial, mode, coast, flow, waves };
  }, [shore, light]);
  useEffect(
    () => () => {
      resources.material.dispose();
      resources.referenceMaterial?.dispose();
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
      name="City water"
      rotation-x={-Math.PI / 2}
      position-y={TERRAIN.waterY}
      material={resources.material}
      receiveShadow
      userData={{ excludeSunBounds: true, water: resources }}
    >
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}
