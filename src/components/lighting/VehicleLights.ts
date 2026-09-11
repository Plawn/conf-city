import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";
import type { Pool } from "../traffic/sim";
import { createLightSource, type LightingRuntime, type LocalLightSource } from "./runtime";
import { BrakeTracker } from "./selection";

/** Two instanced draws per pool. Bulb transforms use the same full pose as the vehicle. */
export function createVehicleLights(
  capacity: number,
  scale: number,
  prefix: string,
  runtime: LightingRuntime,
) {
  const group = new Group();
  const geometry = new BoxGeometry(0.048, 0.035, 0.015);
  const frontMaterial = new MeshBasicMaterial({ color: "white", toneMapped: false });
  const rearMaterial = new MeshBasicMaterial({ color: "white", toneMapped: false });
  const front = new InstancedMesh(geometry, frontMaterial, capacity * 2);
  const rear = new InstancedMesh(geometry, rearMaterial, capacity * 2);
  for (const mesh of [front, rear]) {
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.raycast = () => {};
    group.add(mesh);
  }
  const sources = new Map<number, LocalLightSource>();
  const brakes = new BrakeTracker();
  const ids = new Set<number>();
  const matrix = new Matrix4();
  const pose = new Matrix4();
  const rotation = new Quaternion();
  const position = new Vector3();
  const scaling = new Vector3();
  const white = new Color();
  const red = new Color();
  return {
    group,
    update(pool: Pool, dt: number) {
      ids.clear();
      for (let i = 0; i < pool.count; i++) {
        const id = pool.id[i]!;
        ids.add(id);
        const opacity = pool.opacity[i]!;
        const brake = brakes.update(id, pool.vel[i]!, dt);
        rotation.set(pool.qx[i]!, pool.qy[i]!, pool.qz[i]!, pool.qw[i]!);
        position.set(pool.x[i]!, pool.y[i]!, pool.z[i]!);
        pose.compose(position, rotation, scaling.setScalar(scale * opacity));
        const night = runtime.night.value;
        white.setRGB(1, 0.91, 0.72).multiplyScalar(0.15 + night * 2.4);
        red.setRGB(1, 0.015, 0.004).multiplyScalar(0.12 + night * 0.9 + brake * 2.6);
        for (let side = 0; side < 2; side++) {
          const x = side === 0 ? -0.092 : 0.092;
          matrix.makeTranslation(x, 0.1, 0.279).premultiply(pose);
          front.setMatrixAt(i * 2 + side, matrix);
          front.setColorAt(i * 2 + side, white);
          matrix.makeTranslation(x, 0.1, -0.279).premultiply(pose);
          rear.setMatrixAt(i * 2 + side, matrix);
          rear.setColorAt(i * 2 + side, red);
        }
        let source = sources.get(id);
        if (!source) {
          source = createLightSource(`${prefix}:${id}`, "vehicle");
          sources.set(id, source);
          runtime.sources.set(source.id, source);
        }
        source.position.set(0, 0.1, 0.28).applyMatrix4(pose);
        source.direction.set(0, -0.12, 1).applyQuaternion(rotation).normalize();
        // Same offset as the bulbs, so a split pair sits exactly on them (bridge roll included).
        source.lateral
          .set(0.092, 0, 0)
          .applyQuaternion(rotation)
          .multiplyScalar(scale * opacity);
        source.color.setRGB(1, 0.91, 0.72);
        source.intensity = 9 * opacity;
        source.range = 4 * scale;
        source.angle = 0.32;
        source.visible = opacity > 0.01;
      }
      brakes.retain(ids);
      for (const [id, source] of sources) {
        if (!ids.has(id)) {
          runtime.sources.delete(source.id);
          sources.delete(id);
        }
      }
      for (const mesh of [front, rear]) {
        mesh.count = pool.count * 2;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.needsUpdate = true;
        }
      }
    },
    dispose() {
      for (const source of sources.values()) {
        runtime.sources.delete(source.id);
      }
      front.dispose();
      rear.dispose();
      geometry.dispose();
      frontMaterial.dispose();
      rearMaterial.dispose();
    },
  };
}
