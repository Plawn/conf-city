import * as THREE from "three";
import type { Pool } from "../../sim/traffic/pool";

/** Raycast stub for meshes that must never be picked; one shared function, no per-render closure. */
export const NO_RAYCAST = (): void => {};

/**
 * An `InstancedMesh` rewritten every frame: starts empty, never frustum-culled
 * (instances move, the mesh bounds never follow), dynamic matrices, not pickable.
 */
export function dynamicInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.raycast = NO_RAYCAST;
  return mesh;
}

const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const scaling = new THREE.Vector3();

/** Writes the pose of pool slot `i`, uniformly scaled by `scale`, into `out`; allocation-free. */
export function poolMatrix(
  pool: Pool,
  i: number,
  scale: number,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  position.set(pool.x[i]!, pool.y[i]!, pool.z[i]!);
  rotation.set(pool.qx[i]!, pool.qy[i]!, pool.qz[i]!, pool.qw[i]!);
  scaling.setScalar(scale);
  return out.compose(position, rotation, scaling);
}
