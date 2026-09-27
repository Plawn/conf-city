import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { bakeSceneGeometry, normaliseGeometry } from "./bakeGltf";

/** Kenney Car Kit (CC0): sedan → car, delivery van → truck. */
export const VEHICLE_MODELS = {
  car: "/models/vehicles/car.glb",
  truck: "/models/vehicles/truck.glb",
} as const;

for (const url of Object.values(VEHICLE_MODELS)) {
  useGLTF.preload(url);
}

/** Bumper-to-bumper length in world units once scaled (a road is 1.2 wide). */
const VEHICLE_LENGTH = 0.55;

/**
 * One InstancedMesh per vehicle model needs a single geometry, so the GLTF's
 * body + four wheels are baked into one buffer.
 *
 * The kit's models already point their nose at +Z (front wheels sit at +Z, the
 * delivery van's rear door at -Z), which is also the direction TrafficSystem
 * yaws instances towards, so no rotation is applied — worth a second look if
 * the fleet ever drives backwards. Output is centred in X/Z with the wheels
 * resting exactly on y=0.
 */
export function useVehicleGeometry(url: string): {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
} {
  const { scene } = useGLTF(url);

  const { geometry, material } = useMemo(() => {
    const baked = bakeSceneGeometry(scene);
    const source = baked.source;
    // Normalise size and origin: length VEHICLE_LENGTH along Z, wheels on the ground.
    const geometry = normaliseGeometry(baked.geometry, VEHICLE_LENGTH, { rest: "ground" });

    // Keep the kit's colormap look, but own the instance-colour flag on our copy.
    const material = source ? source.clone() : new THREE.MeshStandardMaterial({ color: "#ffffff" });

    return { geometry, material };
  }, [scene]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return { geometry, material };
}
