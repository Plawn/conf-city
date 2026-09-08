import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The utility district's fixed parts, built once for the whole app.
 *
 * Nothing here depends on a metric: a power station is a power station whether
 * the CPU is at 3 % or 97 %. What moves is put on top of these shells by the
 * components — the smoke, the water in the tank, the boxes on the quay — so a
 * changing figure never rebuilds a vertex. Each installation is **one merged,
 * vertex-coloured geometry**, i.e. one draw call per island, which is what lets
 * a dozen islands carry a district each without touching the frame budget.
 *
 * Everything is modelled in a slot's local frame: the model faces −Z (the open
 * sea, `UtilitySlot.yaw`), stands on y = 0, and fits inside roughly 3.4 along
 * the shore by 2.2 out to the water — the room `layout/utilityPlot.ts`
 * reserves. A cramped island scales the whole group down rather than reshaping
 * anything.
 */

/** Linear RGB, kept desaturated and under the bloom threshold like the industrial kit. */
const SHADE = {
  concrete: [0.62, 0.62, 0.6],
  apron: [0.44, 0.44, 0.47],
  wall: [0.8, 0.79, 0.76],
  roof: [0.5, 0.53, 0.6],
  metal: [0.66, 0.68, 0.72],
  dark: [0.3, 0.31, 0.35],
  rust: [0.55, 0.36, 0.26],
  timber: [0.6, 0.5, 0.36],
} as const satisfies Record<string, readonly [number, number, number]>;

type Shade = readonly [number, number, number];

/** Sizes the components need back: where the smoke leaves, how tall the tank is. */
export const PLANT = { chimneyX: 1.05, chimneyTop: 3.1, chimneyRadius: 0.24 } as const;
export const TOWER = { tankY: 1.75, tankHeight: 1.5, tankRadius: 0.68 } as const;
export const QUAY = {
  /** Boxes the quay holds when the disk is full: 4 along the shore × 3 high. */
  cols: 4,
  rows: 1,
  layers: 3,
  box: [0.62, 0.44, 0.72] as const,
  deckY: 0.16,
} as const;
export const QUAY_CAPACITY = QUAY.cols * QUAY.rows * QUAY.layers;

class Builder {
  private parts: THREE.BufferGeometry[] = [];

  add(geometry: THREE.BufferGeometry, shade: Shade): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) {
      geometry.dispose();
    }
    const count = g.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = shade[0];
      colors[i * 3 + 1] = shade[1];
      colors[i * 3 + 2] = shade[2];
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.parts.push(g);
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, shade: Shade): void {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    this.add(g, shade);
  }

  pipe(x: number, y: number, z: number, r: number, h: number, shade: Shade, sides = 10): void {
    const g = new THREE.CylinderGeometry(r, r, h, sides);
    g.translate(x, y, z);
    this.add(g, shade);
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) {
      p.dispose();
    }
    this.parts = [];
    if (!merged) {
      throw new Error("utility geometry: parts do not share an attribute set");
    }
    merged.computeVertexNormals();
    return merged;
  }
}

/** CPU: a turbine hall with a cooling stack the smoke leaves from. */
function buildPlant(): THREE.BufferGeometry {
  const b = new Builder();
  b.box(0, 0.06, 0, 3.2, 0.12, 2.0, SHADE.apron);
  // The hall, its saw-tooth roof band, and the transformer yard beside the door.
  b.box(-0.5, 0.62, 0, 1.9, 1.0, 1.4, SHADE.wall);
  b.box(-0.5, 1.2, 0, 2.0, 0.18, 1.5, SHADE.roof);
  b.box(-0.5, 0.5, -0.72, 0.7, 0.8, 0.1, SHADE.dark);
  b.box(0.55, 0.35, 0.4, 0.5, 0.46, 0.5, SHADE.metal);
  // The stack: a tapered concrete tube with two bands, so it is not a plain pipe.
  const stack = new THREE.CylinderGeometry(
    PLANT.chimneyRadius,
    PLANT.chimneyRadius * 1.5,
    PLANT.chimneyTop,
    10,
  );
  stack.translate(PLANT.chimneyX, PLANT.chimneyTop / 2, 0);
  b.add(stack, SHADE.concrete);
  b.pipe(PLANT.chimneyX, PLANT.chimneyTop - 0.35, 0, PLANT.chimneyRadius + 0.06, 0.16, SHADE.rust);
  b.pipe(PLANT.chimneyX, PLANT.chimneyTop * 0.55, 0, PLANT.chimneyRadius + 0.07, 0.14, SHADE.rust);
  return b.build();
}

/**
 * RAM: four legs and an **open** tank — a rim, a floor and slender stanchions,
 * no wall. A closed cylinder hides the one thing this model exists to show; from
 * the city's usual three-quarter view the water has to be visible from the side.
 */
function buildWaterTower(): THREE.BufferGeometry {
  const b = new Builder();
  b.box(0, 0.06, 0, 2.0, 0.12, 1.8, SHADE.apron);
  const legY = TOWER.tankY - TOWER.tankHeight / 2;
  for (const [lx, lz] of [
    [-0.55, -0.5],
    [0.55, -0.5],
    [-0.55, 0.5],
    [0.55, 0.5],
  ] as const) {
    b.box(lx, legY / 2, lz, 0.13, legY, 0.13, SHADE.metal);
  }
  // Cross-bracing, or the legs read as four unconnected sticks from above.
  b.box(0, legY * 0.55, -0.5, 1.1, 0.08, 0.08, SHADE.metal);
  b.box(0, legY * 0.55, 0.5, 1.1, 0.08, 0.08, SHADE.metal);
  // The tank floor, its rim, and the six uprights between them.
  b.pipe(0, legY + 0.05, 0, TOWER.tankRadius, 0.12, SHADE.metal, 14);
  b.pipe(0, TOWER.tankY + TOWER.tankHeight / 2, 0, TOWER.tankRadius + 0.05, 0.12, SHADE.dark, 14);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.box(
      Math.cos(a) * TOWER.tankRadius,
      TOWER.tankY,
      Math.sin(a) * TOWER.tankRadius,
      0.09,
      TOWER.tankHeight,
      0.09,
      SHADE.metal,
    );
  }
  // The ladder up one leg: what says "tower" rather than "barrel on stilts".
  b.box(0.55, legY / 2, 0.62, 0.16, legY, 0.05, SHADE.dark);
  return b.build();
}

/** DISK: a deck out over the water and the gantry that stacks it. */
function buildQuay(): THREE.BufferGeometry {
  const b = new Builder();
  b.box(0, QUAY.deckY / 2, 0, 3.2, QUAY.deckY, 2.0, SHADE.concrete);
  // Bollards along the seaward edge — the side a ship would come alongside.
  for (const x of [-1.2, 0, 1.2]) {
    b.pipe(x, QUAY.deckY + 0.1, -0.9, 0.07, 0.2, SHADE.dark, 6);
  }
  // The gantry straddles the stacks: two legs each side and a beam over the top.
  const railY = 2.3;
  for (const lx of [-1.35, 1.35]) {
    for (const lz of [-0.7, 0.7]) {
      b.box(lx, railY / 2, lz, 0.12, railY, 0.12, SHADE.metal);
    }
    b.box(lx, railY, 0, 0.16, 0.16, 1.5, SHADE.metal);
  }
  b.box(0, railY + 0.14, 0, 3.0, 0.18, 0.24, SHADE.rust);
  b.box(0.4, railY - 0.3, 0, 0.36, 0.4, 0.36, SHADE.dark);
  return b.build();
}

/**
 * The scaffolding an installation wears when its figure is not a machine
 * measurement: a frame and a timber hoarding, no gauge at all. Better an
 * obvious building site than a chimney at rest passing for an idle CPU.
 */
function buildScaffold(): THREE.BufferGeometry {
  const b = new Builder();
  b.box(0, 0.06, 0, 2.4, 0.12, 1.6, SHADE.apron);
  const h = 1.7;
  for (const [lx, lz] of [
    [-0.85, -0.55],
    [0.85, -0.55],
    [-0.85, 0.55],
    [0.85, 0.55],
  ] as const) {
    b.box(lx, h / 2, lz, 0.1, h, 0.1, SHADE.rust);
  }
  for (const y of [h * 0.45, h * 0.95]) {
    b.box(0, y, -0.55, 1.8, 0.07, 0.07, SHADE.rust);
    b.box(0, y, 0.55, 1.8, 0.07, 0.07, SHADE.rust);
    b.box(-0.85, y, 0, 0.07, 0.07, 1.2, SHADE.rust);
    b.box(0.85, y, 0, 0.07, 0.07, 1.2, SHADE.rust);
  }
  // A half-built wall and the planks stacked against it.
  b.box(0, 0.45, 0, 1.5, 0.7, 0.9, SHADE.wall);
  b.box(0.4, 0.95, -0.4, 1.0, 0.12, 0.4, SHADE.timber);
  return b.build();
}

export const plantGeometry = buildPlant();
export const waterTowerGeometry = buildWaterTower();
export const quayGeometry = buildQuay();
export const scaffoldGeometry = buildScaffold();

/** The water in the tank: a unit-height cylinder scaled by the level, never rebuilt. */
export const waterGeometry = new THREE.CylinderGeometry(
  TOWER.tankRadius - 0.06,
  TOWER.tankRadius - 0.06,
  1,
  14,
);
waterGeometry.translate(0, 0.5, 0);

/**
 * The container liveries, the same linear triplets the `industrial-terminal`
 * building stacks on its own apron — a box is a box wherever it is parked.
 */
export const CONTAINER_SHADES: readonly Shade[] = [
  [0.74, 0.7, 0.64],
  [0.56, 0.58, 0.62],
  [0.66, 0.6, 0.5],
];
/** The one box too many on a full disk: the only one that is not a livery. */
export const OVERFLOW_SHADE: Shade = [0.62, 0.22, 0.1];

/** One puff of smoke, and one container. Both are drawn as instances. */
export const puffGeometry = new THREE.IcosahedronGeometry(0.26, 0);
export const containerGeometry = new THREE.BoxGeometry(...QUAY.box);
