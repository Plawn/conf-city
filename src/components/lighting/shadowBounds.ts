import {
  Box3,
  type BufferGeometry,
  InstancedMesh,
  type Matrix4,
  Mesh,
  type Object3D,
  Vector3,
} from "three";

/** Cached per-mesh bounds; never recursively expand a mesh's children a second time. */
export class ShadowBoundsCache {
  private entries = new WeakMap<
    Mesh,
    { geometry: BufferGeometry; local: Box3; world: Box3; matrix: Matrix4 }
  >();

  collect(scene: Object3D, target: Box3): void {
    target.makeEmpty();
    // Rendering already updates world matrices. Use the last rendered transforms;
    // shadow fitting may lag animated heights by one frame, within its 6-unit margin.
    scene.traverseVisible((object) => {
      if (
        !(object instanceof Mesh) ||
        (!object.castShadow && !object.receiveShadow) ||
        object.userData.excludeSunBounds ||
        (object instanceof InstancedMesh && !object.userData.buildingBatch)
      ) {
        return;
      }
      const geometry = object.geometry;
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      const local = object instanceof InstancedMesh ? object.boundingBox : geometry.boundingBox;
      if (!local || local.isEmpty()) {
        return;
      }
      let entry = this.entries.get(object);
      if (!entry) {
        entry = {
          geometry,
          local: local.clone(),
          world: local.clone().applyMatrix4(object.matrixWorld),
          matrix: object.matrixWorld.clone(),
        };
        this.entries.set(object, entry);
      } else if (
        entry.geometry !== geometry ||
        !entry.local.equals(local) ||
        !entry.matrix.equals(object.matrixWorld)
      ) {
        entry.geometry = geometry;
        entry.local.copy(local);
        entry.matrix.copy(object.matrixWorld);
        entry.world.copy(local).applyMatrix4(object.matrixWorld);
      }
      target.union(entry.world);
    });
  }
}

/** Fit finite caster/receiver bounds in light space. Snap center, retaining a texel margin. */
export function fitShadowBounds(bounds: Box3, lightView: Matrix4, mapSize = 2048) {
  const projected = new Box3();
  const p = new Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        projected.expandByPoint(p.set(x, y, z).applyMatrix4(lightView));
      }
    }
  }
  const width = Math.max(4, projected.max.x - projected.min.x + 4);
  const height = Math.max(4, projected.max.y - projected.min.y + 4);
  const tx = width / (mapSize - 2);
  const ty = height / (mapSize - 2);
  const cx = Math.round((projected.min.x + projected.max.x) / 2 / tx) * tx;
  const cy = Math.round((projected.min.y + projected.max.y) / 2 / ty) * ty;
  return {
    left: cx - width / 2 - tx,
    right: cx + width / 2 + tx,
    bottom: cy - height / 2 - ty,
    top: cy + height / 2 + ty,
    near: Math.max(0.1, -projected.max.z - 4),
    far: Math.max(8, -projected.min.z + 4),
  };
}
