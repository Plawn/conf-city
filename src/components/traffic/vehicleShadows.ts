import {
  CanvasTexture,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { clamp01 } from "../../lib/math";
import type { Pool } from "../../sim/traffic/pool";

/** Blob footprint relative to the normalised vehicle (0.55 long along Z). */
const BLOB_WIDTH = 0.36;
const BLOB_LENGTH = 0.72;
/** Lift above the road so the decal wins the depth test without z-fighting. */
const BLOB_LIFT = 0.006;
/** Opacity at night (ambient contact shadow) and its extra under full sun. */
const BLOB_NIGHT_OPACITY = 0.12;
const BLOB_SUN_OPACITY = 0.3;

let sharedAlpha: CanvasTexture | null = null;

/** Radial falloff shared by every pool; generated once, never fetched. */
function blobAlphaMap(): CanvasTexture {
  if (sharedAlpha) {
    return sharedAlpha;
  }
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.12,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  sharedAlpha = new CanvasTexture(canvas);
  return sharedAlpha;
}

const pose = new Matrix4();
const local = new Matrix4();
const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();

/** Instanced blob decals under vehicles, replacing 300 casters in the sun map. */
export function createVehicleShadows(capacity: number, vehicleScale: number) {
  const geometry = new PlaneGeometry(BLOB_WIDTH, BLOB_LENGTH);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    color: 0x000000,
    alphaMap: blobAlphaMap(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    opacity: BLOB_NIGHT_OPACITY,
  });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.raycast = () => {};
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  mesh.userData.excludeSunBounds = true;
  return {
    mesh,
    /** Faint contact at night, a real shadow by day. */
    setSunPower(sunPower: number) {
      const opacity = BLOB_NIGHT_OPACITY + BLOB_SUN_OPACITY * clamp01(sunPower);
      if (material.opacity !== opacity) {
        material.opacity = opacity;
      }
    },
    /** Follows the pool pose; call next to `writeMatrices`. */
    update(pool: Pool) {
      if (pool.count === 0 && mesh.count === 0) {
        return;
      }
      for (let i = 0; i < pool.count; i++) {
        const s = vehicleScale * pool.opacity[i]!;
        position.set(pool.x[i]!, pool.y[i]!, pool.z[i]!);
        rotation.set(pool.qx[i]!, pool.qy[i]!, pool.qz[i]!, pool.qw[i]!);
        scale.setScalar(s);
        pose.compose(position, rotation, scale);
        local.makeTranslation(0, BLOB_LIFT / Math.max(1e-3, s), 0);
        mesh.setMatrixAt(i, pose.multiply(local));
      }
      mesh.count = pool.count;
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
