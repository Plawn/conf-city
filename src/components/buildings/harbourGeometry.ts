import * as THREE from "three";
import { createBuilder, type Shade } from "./colouredBuilder";

/**
 * Procedural fallback for the two port assets, written like
 * `industrialGeometry.ts`: box/pipe primitives, one merged vertex-coloured
 * geometry, no texture and no GLB.
 *
 * `PORT_ASSETS` (domain/nodeStyle.ts) is null until the real models land in
 * `public/models/port/`; until then a marked ingress service is drawn with
 * `harbourGeometry()` and its ships with `shipGeometry()`. Both are modelled in
 * the same conventions as the kits they will be swapped for: **façade / bow
 * toward −Z** for the quay (building convention) and **bow toward +Z** for the
 * ship (vehicle convention), +Y up, footprint centred on the origin, and — for
 * the quay — the reference height of a building model, so `NODE_STYLE.scale`
 * brings it to the plot without a `fit` of its own.
 *
 * Shades stay desaturated and ≤ 0.72 per channel: `NodeMesh` multiplies the
 * whole model by the type/biome tint, and the bloom threshold is 0.8.
 */

const SHADE = {
  deck: [0.5, 0.5, 0.54],
  deckEdge: [0.42, 0.42, 0.47],
  fender: [0.24, 0.24, 0.28],
  bollard: [0.3, 0.31, 0.35],
  craneLeg: [0.64, 0.62, 0.5],
  craneBoom: [0.7, 0.68, 0.54],
  craneCab: [0.3, 0.32, 0.38],
  shed: [0.66, 0.66, 0.63],
  shedRoof: [0.56, 0.58, 0.64],
  containerA: [0.62, 0.42, 0.36],
  containerB: [0.36, 0.48, 0.56],
  containerC: [0.6, 0.58, 0.4],
  hull: [0.28, 0.32, 0.42],
  hullBoot: [0.5, 0.28, 0.26],
  shipDeck: [0.52, 0.52, 0.55],
  bridgeHouse: [0.72, 0.72, 0.7],
  window: [0.22, 0.26, 0.32],
  funnel: [0.4, 0.35, 0.3],
} as const satisfies Record<string, readonly [number, number, number]>;

/** The primitive kit shared by both models: everything ends up in one buffer. 8-sided pipes — low-poly kit. */
const builder = () => createBuilder({ finish: (merged) => merged.computeBoundingBox() });

/**
 * The quay: a deck along the shore, two gantry cranes reaching over the water,
 * a stack of containers and a transit shed.
 *
 * The **sea is toward −Z** — the same face a Kenney building presents to the
 * street — so `NodeMesh` can turn the port to the berth's bearing with the one
 * rotation it already applies to a model.
 */
export function harbourGeometry(): THREE.BufferGeometry {
  const { box, pipe, build } = builder();

  // Deck: wide along X (it follows the shore), the seaward half over the water.
  box(0, 0.11, 0.06, 1.5, 0.22, 1.05, SHADE.deck);
  // The quay wall's coping, and the fenders hanging off it into the sea.
  box(0, 0.235, -0.45, 1.5, 0.03, 0.09, SHADE.deckEdge);
  for (const x of [-0.55, -0.18, 0.18, 0.55]) {
    box(x, 0.13, -0.48, 0.1, 0.16, 0.04, SHADE.fender);
  }
  // Bollards along the edge: the detail that says "ships tie up here".
  for (const x of [-0.62, -0.24, 0.24, 0.62]) {
    pipe(x, 0.27, -0.4, 0.032, 0.09, SHADE.bollard);
  }

  // Two gantry cranes straddling the quay, booms cantilevered over the water.
  for (const cx of [-0.42, 0.36]) {
    for (const lz of [-0.3, 0.28]) {
      box(cx - 0.16, 0.5, lz, 0.05, 0.55, 0.05, SHADE.craneLeg);
      box(cx + 0.16, 0.5, lz, 0.05, 0.55, 0.05, SHADE.craneLeg);
    }
    // Portal beam, then the boom reaching seaward past the quay edge.
    box(cx, 0.79, -0.01, 0.42, 0.06, 0.68, SHADE.craneLeg);
    box(cx, 0.84, -0.28, 0.1, 0.05, 0.86, SHADE.craneBoom);
    box(cx, 0.72, -0.02, 0.11, 0.09, 0.1, SHADE.craneCab);
    // Hoist cable and its spreader, hanging over the berth.
    box(cx, 0.66, -0.62, 0.02, 0.32, 0.02, SHADE.bollard);
    box(cx, 0.48, -0.62, 0.16, 0.03, 0.16, SHADE.craneCab);
  }

  // Transit shed on the landward strip, so the port is not all steelwork.
  box(-0.02, 0.36, 0.44, 0.62, 0.28, 0.3, SHADE.shed);
  box(-0.02, 0.51, 0.44, 0.66, 0.04, 0.34, SHADE.shedRoof);

  // Container stacks: alternating colours, the yard's whole point.
  const stacks: Array<[number, number, Shade, Shade]> = [
    [0.55, 0.42, SHADE.containerA, SHADE.containerB],
    [0.55, 0.13, SHADE.containerC, SHADE.containerA],
    [-0.6, 0.36, SHADE.containerB, SHADE.containerC],
  ];
  for (const [x, z, lower, upper] of stacks) {
    box(x, 0.29, z, 0.3, 0.13, 0.19, lower);
    box(x, 0.42, z, 0.3, 0.13, 0.19, upper);
  }
  box(-0.6, 0.29, 0.12, 0.26, 0.13, 0.17, SHADE.containerA);

  return build();
}

/**
 * The ship, **bow toward +Z** (the Car Kit convention `useVehicleGeometry`
 * relies on), floating with its waterline at y = 0: a hull, a boot-top stripe,
 * a deckhouse aft and three rows of containers.
 */
export function shipGeometry(): THREE.BufferGeometry {
  const { add, box, pipe, build } = builder();

  // Hull: a box aft, a wedge forward, so the bow reads at any camera distance.
  box(0, 0.1, -0.25, 0.62, 0.3, 1.2, SHADE.hull);
  const bow = new THREE.Shape();
  bow.moveTo(-0.31, 0);
  bow.lineTo(0.31, 0);
  bow.lineTo(0, 0.62);
  bow.closePath();
  const nose = new THREE.ExtrudeGeometry(bow, { depth: 0.3, bevelEnabled: false });
  // The shape lives in XY and extrudes along +Z; `rotateX(+π/2)` lays it flat with
  // the apex at +Z and the extrusion becoming the hull's depth, which is then
  // lifted to the hull's own top (0.25) and pushed to its forward end.
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 0.25, 0.35);
  add(nose, SHADE.hull);

  // Boot top: the one band of colour on an otherwise grey hull.
  box(0, -0.02, -0.25, 0.64, 0.06, 1.21, SHADE.hullBoot);
  // Weather deck, flush with the top of the hull.
  box(0, 0.26, -0.2, 0.58, 0.03, 1.35, SHADE.shipDeck);

  // Deckhouse aft, with a window band and a funnel above it.
  box(0, 0.42, -0.68, 0.42, 0.28, 0.28, SHADE.bridgeHouse);
  box(0, 0.47, -0.68, 0.44, 0.07, 0.3, SHADE.window);
  pipe(0, 0.64, -0.72, 0.06, 0.16, SHADE.funnel);

  // Three rows of containers forward of the house — the cargo, and the silhouette.
  const rows: Array<[number, Shade, Shade]> = [
    [-0.32, SHADE.containerA, SHADE.containerB],
    [0.02, SHADE.containerB, SHADE.containerC],
    [0.36, SHADE.containerC, SHADE.containerA],
  ];
  for (const [z, lower, upper] of rows) {
    for (const x of [-0.15, 0.15]) {
      box(x, 0.35, z, 0.26, 0.14, 0.3, lower);
      box(x, 0.49, z, 0.26, 0.14, 0.3, upper);
    }
  }

  return build();
}
