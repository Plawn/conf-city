import { expect, test } from "bun:test";
import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Texture,
  Vector3,
} from "three";
import { BIOMES } from "../../domain/biome";
import { buildingVariant } from "../../domain/buildingVariant";
import { ShadowBoundsCache } from "../lighting/shadowBounds";
import { AnimationQueue } from "./animationQueue";
import { type BuildingBinding, BuildingInstances, buildingModel } from "./instances";
import {
  heightTarget,
  MaterialAnimation,
  settled,
  type VisualState,
  visualTarget,
} from "./visuals";

const variant = buildingVariant("city/node", "app", BIOMES.meadow);
const visual: VisualState = {
  mode: "health",
  liveness: "healthy",
  cpuSat: 0.4,
  rps: 0,
  errorRate: 0,
  hovered: false,
  selected: false,
};

test("settled buildings sleep, inputs and night wake them, removed tasks never run", () => {
  const queue = new AnimationQueue();
  const material = {
    color: new Color(variant.color),
    emissive: new Color(variant.emissive),
    emissiveIntensity: 0.3,
  };
  const animation = new MaterialAnimation(variant, 0);
  let current = visual;
  let visits = 0;
  const step = (time: number, delta: number, night: number) => {
    visits++;
    return animation.advance([material], current, night, time, delta).active;
  };
  const remove = queue.add(step, true);
  for (let i = 0; i < 200; i++) {
    queue.advance(i / 30, 1 / 30, 0);
  }
  const resting = visits;
  queue.advance(10, 1 / 30, 0);
  expect(visits).toBe(resting);
  expect(queue.visits).toBe(0);
  queue.advance(11, 1 / 30, 1);
  expect(visits).toBe(resting + 1);
  current = { ...visual, selected: true };
  queue.add(step, true);
  for (let i = 0; i < 200; i++) {
    queue.advance(12 + i / 30, 1 / 30, 1);
  }
  const target = visualTarget(current, variant, 0, 1, 20);
  expect(settled(material, target.color, target.emissive, target.intensity)).toBe(true);
  remove();
  const removed = visits;
  queue.advance(21, 1 / 30, 0);
  expect(visits).toBe(removed);
});

test("errors keep animating, recovery settles, heatmaps and down status retain their targets", () => {
  const animation = new MaterialAnimation(variant, 0);
  const material = { color: new Color(), emissive: new Color(), emissiveIntensity: 0 };
  const error = { ...visual, errorRate: 0.1 };
  for (let i = 0; i < 100; i++) {
    expect(animation.advance([material], error, 0, i / 30, 1 / 30).active).toBe(true);
  }
  for (let i = 0; i < 200; i++) {
    animation.advance([material], visual, 0, i / 30, 1 / 30);
  }
  expect(animation.advance([material], visual, 0, 10, 1 / 30).active).toBe(false);
  expect(visualTarget({ ...error, liveness: "down" }, variant, 0, 1, 0).intensity).toBe(0.1);
  expect(
    visualTarget({ ...visual, mode: "cpu", heat: undefined }, variant, 0, 1, 0).intensity,
  ).toBe(0.05);
  expect(heightTarget("app", { ...visual, memNorm: 1 })).toBe(1.7);
  expect(heightTarget("db", { ...visual, memNorm: 1 })).toBe(1.15);
});

test("batches preserve nested transforms, textures, instance identity and bounds after growth/removal", () => {
  const scene = new Group();
  const nested = new Group();
  nested.position.set(2, 1, 0);
  nested.rotation.y = 0.3;
  scene.add(nested);
  const geometry = new BoxGeometry(1, 2, 1);
  const map = new Texture();
  const normalMap = new Texture();
  nested.add(new Mesh(geometry, new MeshStandardMaterial({ map, normalMap })));
  const model = buildingModel(scene);
  const instances = new BuildingInstances();
  let hovered = "";
  const bindings: BuildingBinding[] = Array.from({ length: 9 }, (_, i) => ({
    id: `node-${i}`,
    matrix: new Matrix4().makeTranslation(i * 2, 0, 0),
    visual: {
      color: new Color().setRGB(i / 10, 0.2, 0.4),
      emissive: new Color(0xff0000),
      emissiveIntensity: i / 10,
    },
    hover: (active) => {
      hovered = active ? `node-${i}` : "";
    },
    click: () => {},
  }));
  const registrations = bindings.map((binding) => instances.add(binding, model.parts));
  instances.flush();
  expect(instances.batches.size).toBe(1);
  const batch = [...instances.batches.values()][0]!;
  const mesh = batch.mesh;
  if (!(mesh instanceof InstancedMesh)) {
    throw new Error("Repeated models must use an instanced draw");
  }
  expect(mesh.count).toBe(9);
  expect(mesh.material).toMatchObject({ map, normalMap });
  const matrix = new Matrix4();
  mesh.getMatrixAt(8, matrix);
  const expected = bindings[8]!.matrix;
  matrix.elements.forEach((value, i) => {
    expect(value).toBeCloseTo(expected.elements[i]!, 5);
  });
  expect(geometry.hasAttribute("buildingEmission")).toBe(false);
  instances.hover(bindings[1]!);
  expect(hovered).toBe("node-1");
  registrations[1]!.remove();
  expect(hovered).toBe("");
  expect(batch.slots[1]!.binding.id).toBe("node-8");
  bindings[8]!.matrix.makeScale(1, 30, 1).setPosition(16, 0, 0);
  registrations[8]!.write(true, false);
  instances.flush();
  const bounds = new Box3();
  const cache = new ShadowBoundsCache();
  instances.group.updateMatrixWorld(true);
  cache.collect(instances.group, bounds);
  expect(bounds.max.y).toBeGreaterThan(50);
  expect(bounds.containsPoint(new Vector3(18, 30, 0))).toBe(true);
  expect(instances.flush()).toBe(0);
  for (let i = 0; i < 1000; i++) {
    registrations[8]!.write(true, true);
  }
  expect(mesh.instanceMatrix.updateRanges).toHaveLength(1);
  expect(mesh.instanceColor!.updateRanges).toHaveLength(1);
  for (let i = 0; i < registrations.length; i++) {
    if (i !== 1) {
      registrations[i]!.remove();
    }
  }
  expect(instances.group.children).toHaveLength(0);
  expect(instances.batches.size).toBe(0);
  geometry.dispose();
  map.dispose();
  normalMap.dispose();
});

test("distant buildings keep separate culling bounds within the same city and model", () => {
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();
  const scene = new Group();
  scene.add(new Mesh(geometry, material));
  const model = buildingModel(scene);
  const instances = new BuildingInstances();
  const registrations = [0, 100].map((x) =>
    instances.add(
      {
        id: String(x),
        matrix: new Matrix4().makeTranslation(x, 0, 0),
        visual: { color: new Color(), emissive: new Color(), emissiveIntensity: 0 },
        hover: () => {},
        click: () => {},
      },
      model.parts,
    ),
  );
  instances.flush();
  const batches = [...instances.batches.values()];
  expect(batches).toHaveLength(2);
  expect(batches[0]!.mesh).not.toBeInstanceOf(InstancedMesh);
  expect(batches[0]!.mesh.geometry).toBe(batches[1]!.mesh.geometry);
  let released = 0;
  batches[0]!.mesh.geometry.addEventListener("dispose", () => {
    released++;
  });
  expect(new Box3().setFromObject(batches[0]!.mesh).max.x).toBeLessThan(
    new Box3().setFromObject(batches[1]!.mesh).min.x,
  );
  registrations[0]!.remove();
  expect(instances.batches.size).toBe(1);
  expect(released).toBe(0);
  registrations[1]!.remove();
  expect(instances.batches.size).toBe(0);
  expect(released).toBe(1);
  geometry.dispose();
  material.dispose();
});
