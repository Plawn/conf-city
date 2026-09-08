import {
  Box3,
  type BufferAttribute,
  type BufferGeometry,
  type Camera,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  type Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
  Vector3,
} from "three";
import { attribute } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { PITCH } from "../../layout/constants";
import type { MaterialVisual } from "./visuals";

export interface ModelPart {
  key: string;
  geometry: BufferGeometry;
  matrix: Matrix4;
  map: Texture | null;
  normalMap: Texture | null;
}

const models = new WeakMap<Object3D, { parts: ModelPart[]; textured: boolean; bounds: Box3 }>();
const BATCH_SIZE = PITCH * 4;

/** Keep the loader's geometry/textures immutable and flatten nested GLTF transforms once. */
export function buildingModel(scene: Object3D) {
  let model = models.get(scene);
  if (model) {
    return model;
  }
  scene.updateWorldMatrix(true, true);
  const parts: ModelPart[] = [];
  scene.traverseVisible((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    const source = (
      Array.isArray(object.material) ? object.material[0] : object.material
    ) as MeshStandardMaterial;
    const map = source?.map ?? null;
    const normalMap = source?.normalMap ?? null;
    parts.push({
      key: `${scene.uuid}/${object.uuid}`,
      geometry: object.geometry,
      matrix: object.matrixWorld.clone(),
      map,
      normalMap,
    });
  });
  model = {
    parts,
    textured: parts.some((part) => part.map),
    bounds: new Box3().setFromObject(scene),
  };
  models.set(scene, model);
  return model;
}

export interface BuildingBinding {
  id: string;
  matrix: Matrix4;
  visual: MaterialVisual;
  hover: (hovered: boolean) => void;
  click: () => void;
}

interface Slot {
  binding: BuildingBinding;
  index: number;
}

/** Culled batches can stay unsubmitted for hours. Retain one bounded dirty span. */
function markRange(attribute: BufferAttribute, start: number, count: number) {
  const pending = attribute.updateRanges[0];
  if (pending) {
    const end = Math.max(pending.start + pending.count, start + count);
    pending.start = Math.min(pending.start, start);
    pending.count = end - pending.start;
  } else {
    attribute.addUpdateRange(start, count);
  }
  attribute.needsUpdate = true;
}

const singleGeometries = new WeakMap<ModelPart, { geometry: BufferGeometry; users: number }>();

/** Single draws share immutable baked vertices. Release them only after their last user. */
function acquireGeometry(part: ModelPart) {
  let entry = singleGeometries.get(part);
  if (!entry) {
    entry = { geometry: part.geometry.clone().applyMatrix4(part.matrix), users: 0 };
    singleGeometries.set(part, entry);
  }
  entry.users++;
  const shared = entry;
  return {
    geometry: shared.geometry,
    release: () => {
      if (--shared.users === 0) {
        shared.geometry.dispose();
        singleGeometries.delete(part);
      }
    },
  };
}

/** Spatial/model batch: single draws avoid instance overhead; repeated parts share one draw. */
export class BuildingBatch {
  readonly slots: Slot[] = [];
  mesh: Mesh;
  private emission: InstancedBufferAttribute | null = null;
  private material!: MeshStandardNodeMaterial;
  private releaseGeometry: () => void = () => {};
  private capacity = 1;
  private transformsChanged = false;
  writes = 0;

  constructor(
    readonly part: ModelPart,
    private group: Group,
  ) {
    this.mesh = this.createMesh();
  }

  private createMesh(): Mesh {
    const part = this.part;
    const material = new MeshStandardNodeMaterial({
      map: part.map,
      normalMap: part.normalMap,
      vertexColors: part.geometry.hasAttribute("color"),
      color: 0xffffff,
      metalness: 0.08,
      roughness: 0.72,
    });
    this.material = material;
    let mesh: Mesh;
    if (this.capacity === 1) {
      const shared = acquireGeometry(part);
      this.releaseGeometry = shared.release;
      this.emission = null;
      mesh = new Mesh(shared.geometry, material);
      mesh.visible = false;
    } else {
      const geometry = part.geometry.clone().applyMatrix4(part.matrix);
      this.releaseGeometry = () => geometry.dispose();
      this.emission = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(
        DynamicDrawUsage,
      );
      geometry.setAttribute("buildingEmission", this.emission);
      material.emissiveNode = attribute("buildingEmission", "vec3");
      const instanced = new InstancedMesh(geometry, material, this.capacity);
      instanced.count = 0;
      instanced.instanceMatrix.setUsage(DynamicDrawUsage);
      // Allocate before compilation; selection changes only values, never shader topology.
      instanced.setColorAt(0, new Color());
      instanced.instanceColor!.setUsage(DynamicDrawUsage);
      mesh = instanced;
    }
    mesh.name = "building-batch";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.buildingBatch = this;
    this.group.add(mesh);
    return mesh;
  }

  private updateCount() {
    if (this.mesh instanceof InstancedMesh) {
      this.mesh.count = this.slots.length;
    } else {
      this.mesh.visible = this.slots.length > 0;
    }
  }

  add(binding: BuildingBinding) {
    if (this.slots.length === this.capacity) {
      this.grow();
    }
    const slot: Slot = { binding, index: this.slots.length };
    this.slots.push(slot);
    this.updateCount();
    this.write(slot, true, true);
    return slot;
  }

  remove(slot: Slot) {
    const last = this.slots.pop()!;
    if (last !== slot) {
      last.index = slot.index;
      this.slots[last.index] = last;
      this.write(last, true, true);
    }
    this.updateCount();
    this.transformsChanged = true;
  }

  write(slot: Slot, transform: boolean, visual: boolean) {
    const mesh = this.mesh;
    const value = slot.binding.visual;
    if (mesh instanceof InstancedMesh) {
      if (transform) {
        mesh.setMatrixAt(slot.index, slot.binding.matrix);
        markRange(mesh.instanceMatrix, slot.index * 16, 16);
      }
      if (visual) {
        mesh.setColorAt(slot.index, value.color);
        markRange(mesh.instanceColor!, slot.index * 3, 3);
        this.emission!.setXYZ(
          slot.index,
          value.emissive.r * value.emissiveIntensity,
          value.emissive.g * value.emissiveIntensity,
          value.emissive.b * value.emissiveIntensity,
        );
        markRange(this.emission!, slot.index * 3, 3);
      }
    } else {
      if (transform) {
        mesh.matrix.copy(slot.binding.matrix);
        mesh.matrixWorldNeedsUpdate = true;
      }
      if (visual) {
        this.material.color.copy(value.color);
        this.material.emissive.copy(value.emissive);
        this.material.emissiveIntensity = value.emissiveIntensity;
      }
    }
    this.transformsChanged ||= transform;
    this.writes++;
  }

  flush() {
    if (this.transformsChanged && this.mesh instanceof InstancedMesh) {
      this.mesh.computeBoundingBox();
      this.mesh.computeBoundingSphere();
    }
    this.transformsChanged = false;
    const writes = this.writes;
    this.writes = 0;
    return writes;
  }

  private grow() {
    this.dispose();
    this.capacity *= 2;
    this.mesh = this.createMesh();
    this.updateCount();
    for (const slot of this.slots) {
      this.write(slot, true, true);
    }
  }

  dispose() {
    this.group.remove(this.mesh);
    if (this.mesh instanceof InstancedMesh) {
      this.mesh.dispose();
    }
    this.material.dispose();
    this.releaseGeometry();
  }
}

export class BuildingInstances {
  readonly group = new Group();
  readonly batches = new Map<string, BuildingBatch>();
  private hovered: BuildingBinding | null = null;

  add(binding: BuildingBinding, parts: ModelPart[]) {
    const x = Math.floor(binding.matrix.elements[12]! / BATCH_SIZE);
    const z = Math.floor(binding.matrix.elements[14]! / BATCH_SIZE);
    const slots = parts.map((part) => {
      // Keep off-screen parts of a large city independently culled, including in shadow passes.
      const key = `${part.key}/${x}/${z}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = new BuildingBatch(part, this.group);
        this.batches.set(key, batch);
      }
      return { batch, slot: batch.add(binding), key };
    });
    return {
      write: (transform: boolean, visual: boolean) => {
        for (const { batch, slot } of slots) {
          batch.write(slot, transform, visual);
        }
      },
      remove: () => {
        if (this.hovered === binding) {
          this.hover(null);
        }
        for (const { batch, slot, key } of slots) {
          batch.remove(slot);
          if (batch.slots.length === 0) {
            batch.dispose();
            this.batches.delete(key);
          }
        }
      },
    };
  }

  hover(binding: BuildingBinding | null) {
    if (this.hovered === binding) {
      return;
    }
    this.hovered?.hover(false);
    this.hovered = binding;
    binding?.hover(true);
  }

  flush() {
    let writes = 0;
    for (const batch of this.batches.values()) {
      writes += batch.flush();
    }
    return writes;
  }
}

/** Diagnostic-only snapshot for pointer, lifecycle and visual regression checks. */
export function inspectBuildings(
  scene: Object3D,
  camera: Camera,
  rect: { x: number; y: number; width: number; height: number },
) {
  const entries = new Map<BuildingBinding, Box3>();
  const box = new Box3();
  scene.traverseVisible((object) => {
    const batch = object.userData.buildingBatch;
    if (!(batch instanceof BuildingBatch)) {
      return;
    }
    if (!batch.mesh.geometry.boundingBox) {
      batch.mesh.geometry.computeBoundingBox();
    }
    for (const { binding } of batch.slots) {
      let bounds = entries.get(binding);
      if (!bounds) {
        bounds = new Box3();
        entries.set(binding, bounds);
      }
      box.copy(batch.mesh.geometry.boundingBox!).applyMatrix4(binding.matrix);
      bounds.union(box);
    }
  });
  return [...entries].map(([binding, bounds]) => {
    const center = bounds.getCenter(new Vector3());
    const projected = center.clone().project(camera);
    return {
      id: binding.id,
      color: binding.visual.color.toArray(),
      emissive: binding.visual.emissive.toArray(),
      intensity: binding.visual.emissiveIntensity,
      height: bounds.max.y - bounds.min.y,
      position: center.toArray(),
      screen: [
        rect.x + ((projected.x + 1) * rect.width) / 2,
        rect.y + ((1 - projected.y) * rect.height) / 2,
      ],
    };
  });
}
