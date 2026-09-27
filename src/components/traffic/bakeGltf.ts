import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** mergeGeometries needs one identical attribute set everywhere; Kenney ships an unused TANGENT. */
export const KEPT_ATTRIBUTES = new Set(["position", "normal", "uv"]);

/**
 * Every mesh of a GLTF scene baked into one buffer in world space (for a single
 * `InstancedMesh`), plus the first material met; empty geometry for an empty scene.
 */
export function bakeSceneGeometry(scene: THREE.Object3D): {
  geometry: THREE.BufferGeometry;
  source: THREE.Material | undefined;
} {
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
  return { geometry: merged ?? new THREE.BufferGeometry(), source };
}

/**
 * Scales `geometry` in place to `length` along Z and centres it in X/Z; `rest`
 * puts its lowest point on y = 0 (`"ground"`) or keeps the origin (`"waterline"`).
 */
export function normaliseGeometry(
  geometry: THREE.BufferGeometry,
  length: number,
  { rest }: { rest: "ground" | "waterline" },
): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    return geometry;
  }
  const size = box.max.z - box.min.z;
  if (size > 1e-6) {
    const k = length / size;
    geometry.scale(k, k, k);
  }
  geometry.computeBoundingBox();
  const scaled = geometry.boundingBox!;
  geometry.translate(
    -(scaled.min.x + scaled.max.x) / 2,
    rest === "ground" ? -scaled.min.y : 0,
    -(scaled.min.z + scaled.max.z) / 2,
  );
  geometry.computeBoundingSphere();
  return geometry;
}
