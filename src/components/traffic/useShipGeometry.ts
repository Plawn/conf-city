import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PORT_ASSETS } from "../../domain/nodeStyle";
import { shipGeometry } from "../buildings/harbourGeometry";

/** Bow-to-stern length in world units once scaled — a berth is a couple of cells wide. */
const SHIP_LENGTH = 3.2;

/** mergeGeometries needs one identical attribute set everywhere; Kenney ships an unused TANGENT. */
const KEPT_ATTRIBUTES = new Set(["position", "normal", "uv"]);

if (PORT_ASSETS.ship) {
  useGLTF.preload(PORT_ASSETS.ship);
}

/**
 * The cargo ship as ONE geometry, for the single `InstancedMesh` of the fleet —
 * `useVehicleGeometry`'s job, on the harbour's model.
 *
 * Same conventions as the road fleet: the bow points at +Z (which is the
 * direction `IngressPorts` yaws its instances towards) and the result is centred
 * in X/Z. The one difference is Y: a ship floats, so the waterline stays at the
 * origin rather than the hull's bottom, and the caller sets the instance on the
 * water plane without a per-model offset.
 *
 * With `PORT_ASSETS.ship` still null this returns the procedural hull of
 * `buildings/harbourGeometry.ts`, vertex-coloured, and no GLB is fetched at all.
 */
export function useShipGeometry(): {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
} {
  // Hooks cannot be called conditionally: with no GLB configured, drei is asked
  // for a model we know is there (the fleet's own car) and its scene ignored.
  const fallback = PORT_ASSETS.ship === null;
  const { scene } = useGLTF(PORT_ASSETS.ship ?? "/models/vehicles/car.glb");

  const { geometry, material } = useMemo(() => {
    if (fallback) {
      const geometry = normalise(shipGeometry());
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          vertexColors: true,
          metalness: 0.08,
          roughness: 0.7,
        }),
      };
    }

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
    return {
      geometry: normalise(merged ?? new THREE.BufferGeometry()),
      material: source ? source.clone() : new THREE.MeshStandardMaterial({ color: "#ffffff" }),
    };
  }, [scene, fallback]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return { geometry, material };
}

/** Length `SHIP_LENGTH` along Z, centred in X/Z, waterline kept at y = 0. */
function normalise(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    return geometry;
  }
  const length = box.max.z - box.min.z;
  if (length > 1e-6) {
    const k = SHIP_LENGTH / length;
    geometry.scale(k, k, k);
  }
  geometry.computeBoundingBox();
  const scaled = geometry.boundingBox!;
  geometry.translate(-(scaled.min.x + scaled.max.x) / 2, 0, -(scaled.min.z + scaled.max.z) / 2);
  geometry.computeBoundingSphere();
  return geometry;
}
