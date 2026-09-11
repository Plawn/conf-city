import {
  Box3,
  type BufferGeometry,
  InstancedMesh,
  type Matrix4,
  Mesh,
  type Object3D,
  Vector3,
} from "three";

export interface ShadowFit {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
  /** Light-space x/y extent that had to be covered, before margin and texel snap. */
  region: { minX: number; maxX: number; minY: number; maxY: number };
}

/** Cached per-mesh bounds; never recursively expand a mesh's children a second time. */
export class ShadowBoundsCache {
  private entries = new WeakMap<
    Mesh,
    { geometry: BufferGeometry; local: Box3; world: Box3; matrix: Matrix4 }
  >();

  private visited = -1;

  /** Unions visible casters/receivers into `target`; returns whether any entry changed. */
  collect(scene: Object3D, target: Box3): boolean {
    target.makeEmpty();
    let mutated = false;
    let visited = 0;
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
      visited++;
      let entry = this.entries.get(object);
      if (!entry) {
        mutated = true;
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
        mutated = true;
        entry.geometry = geometry;
        entry.local.copy(local);
        entry.matrix.copy(object.matrixWorld);
        entry.world.copy(local).applyMatrix4(object.matrixWorld);
      }
      target.union(entry.world);
    });
    if (visited !== this.visited) {
      mutated = true;
      this.visited = visited;
    }
    return mutated;
  }
}

const NDC_CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/** 8 world-space frustum corners, the far ones pulled in to `maxDistance` from the eye. */
export function frustumCorners(
  projectionInverse: Matrix4,
  cameraWorld: Matrix4,
  maxDistance: number,
  out: Vector3[],
): Vector3[] {
  const eye = new Vector3().setFromMatrixPosition(cameraWorld);
  let i = 0;
  for (const depth of [-1, 1]) {
    for (const [x, y] of NDC_CORNERS) {
      let p = out[i];
      if (!p) {
        p = new Vector3();
        out[i] = p;
      }
      p.set(x, y, depth).applyMatrix4(projectionInverse).applyMatrix4(cameraWorld);
      const distance = p.distanceTo(eye);
      if (distance > maxDistance) {
        p.sub(eye)
          .multiplyScalar(maxDistance / distance)
          .add(eye);
      }
      i++;
    }
  }
  return out;
}

/** Margin around the framed region: fraction of its size, never below this many units. */
const VIEW_MARGIN_RATIO = 0.2;
const VIEW_MARGIN_MIN = 8;

/** Light-space fit of the bounds, narrowed in x/y to `view` points when given; texel-snapped. */
export function fitShadowBounds(
  bounds: Box3,
  lightView: Matrix4,
  mapSize = 2048,
  view?: readonly Vector3[],
): ShadowFit {
  const projected = new Box3();
  const p = new Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        projected.expandByPoint(p.set(x, y, z).applyMatrix4(lightView));
      }
    }
  }
  let minX = projected.min.x;
  let maxX = projected.max.x;
  let minY = projected.min.y;
  let maxY = projected.max.y;
  if (view && view.length > 0) {
    const framed = new Box3();
    for (const point of view) {
      framed.expandByPoint(p.copy(point).applyMatrix4(lightView));
    }
    const ix0 = Math.max(minX, framed.min.x);
    const ix1 = Math.min(maxX, framed.max.x);
    const iy0 = Math.max(minY, framed.min.y);
    const iy1 = Math.min(maxY, framed.max.y);
    if (ix1 > ix0 && iy1 > iy0) {
      const mx = Math.max(VIEW_MARGIN_MIN, (ix1 - ix0) * VIEW_MARGIN_RATIO);
      const my = Math.max(VIEW_MARGIN_MIN, (iy1 - iy0) * VIEW_MARGIN_RATIO);
      minX = Math.max(projected.min.x, ix0 - mx);
      maxX = Math.min(projected.max.x, ix1 + mx);
      minY = Math.max(projected.min.y, iy0 - my);
      maxY = Math.min(projected.max.y, iy1 + my);
    }
  }
  const width = Math.max(4, maxX - minX + 4);
  const height = Math.max(4, maxY - minY + 4);
  const tx = width / (mapSize - 2);
  const ty = height / (mapSize - 2);
  const cx = Math.round((minX + maxX) / 2 / tx) * tx;
  const cy = Math.round((minY + maxY) / 2 / ty) * ty;
  return {
    left: cx - width / 2 - tx,
    right: cx + width / 2 + tx,
    bottom: cy - height / 2 - ty,
    top: cy + height / 2 + ty,
    near: Math.max(0.1, -projected.max.z - 4),
    far: Math.max(8, -projected.min.z + 4),
    region: { minX, maxX, minY, maxY },
  };
}

/** Refit when the region left the previous fit or shrank below `shrink` of its area. */
export function regionNeedsRefit(
  previous: ShadowFit | null,
  region: ShadowFit["region"],
  shrink = 0.25,
): boolean {
  if (!previous) {
    return true;
  }
  const covered =
    region.minX >= previous.left &&
    region.maxX <= previous.right &&
    region.minY >= previous.bottom &&
    region.maxY <= previous.top;
  const area = (region.maxX - region.minX) * (region.maxY - region.minY);
  const previousArea = (previous.right - previous.left) * (previous.top - previous.bottom);
  return !covered || area < previousArea * shrink;
}
