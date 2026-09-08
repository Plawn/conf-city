import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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

/** mergeGeometries needs one identical attribute set everywhere; Kenney ships an unused TANGENT. */
const KEPT_ATTRIBUTES = new Set(["position", "normal", "uv"]);

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
    scene.updateWorldMatrix(true, true);

    const parts: THREE.BufferGeometry[] = [];
    let source: THREE.Material | undefined;
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const baked = child.geometry.clone().applyMatrix4(child.matrixWorld);
      const part = baked.index ? baked.toNonIndexed() : baked;
      if (part !== baked) {
        baked.dispose();
      }
      for (const name of Object.keys(part.attributes)) {
        if (!KEPT_ATTRIBUTES.has(name)) {
          part.deleteAttribute(name);
        }
      }
      parts.push(part);
      if (!source) {
        source = Array.isArray(child.material) ? child.material[0] : child.material;
      }
    });

    const merged = parts.length > 0 ? mergeGeometries(parts) : null;
    for (const part of parts) {
      part.dispose();
    }
    const geometry = merged ?? new THREE.BufferGeometry();

    // Normalise size and origin: length VEHICLE_LENGTH along Z, wheels on the ground.
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) {
      const length = box.max.z - box.min.z;
      if (length > 1e-6) {
        geometry.scale(VEHICLE_LENGTH / length, VEHICLE_LENGTH / length, VEHICLE_LENGTH / length);
      }
      geometry.computeBoundingBox();
      const scaled = geometry.boundingBox!;
      geometry.translate(
        -(scaled.min.x + scaled.max.x) / 2,
        -scaled.min.y,
        -(scaled.min.z + scaled.max.z) / 2,
      );
      geometry.computeBoundingSphere();
    }

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
