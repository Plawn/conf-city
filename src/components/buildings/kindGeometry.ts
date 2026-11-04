import * as THREE from "three";
import type { KindStyle } from "../../domain/nodeStyle";
import { createBuilder, type Shade } from "./colouredBuilder";

/** Linear RGB, desaturated like `industrialGeometry`: the type/biome tint still wins. */
const SHADE = {
  apron: [0.44, 0.44, 0.47],
  wall: [0.84, 0.82, 0.78],
  wallDark: [0.57, 0.58, 0.62],
  brick: [0.66, 0.52, 0.46],
  roof: [0.62, 0.65, 0.72],
  glass: [0.3, 0.36, 0.44],
  frame: [0.9, 0.89, 0.86],
  door: [0.22, 0.23, 0.27],
  grille: [0.24, 0.25, 0.28],
  steel: [0.7, 0.72, 0.76],
  plank: [0.62, 0.5, 0.38],
  plankDark: [0.48, 0.39, 0.3],
  plankLight: [0.72, 0.6, 0.46],
  tin: [0.64, 0.66, 0.68],
  sign: [0.92, 0.9, 0.84],
  stripe: [0.78, 0.42, 0.36],
  bench: [0.55, 0.44, 0.34],
  crate: [0.66, 0.6, 0.5],
  screen: [0.18, 0.26, 0.34],
  lamp: [0.86, 0.5, 0.36],
  stone: [0.8, 0.78, 0.72],
  cable: [0.36, 0.62, 0.68],
} as const satisfies Record<string, Shade>;

/** One merged, vertex-coloured mesh per look: +Y up, door facing −Z, radius ≤ 0.8 to fit any plot. */
export function kindGeometry(style: KindStyle): THREE.BufferGeometry {
  const { add, box, pipe, build } = createBuilder({
    finish: (merged) => merged.computeBoundingBox(),
  });
  const tilted = (
    at: [number, number, number],
    size: [number, number, number],
    rot: [number, number, number],
    shade: Shade,
  ) => {
    const g = new THREE.BoxGeometry(...size);
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
    g.translate(...at);
    add(g, shade);
  };
  /** A pitched roof with its ridge along X, eaves at `y`. */
  const gable = (y: number, width: number, depth: number, rise: number, z = 0) => {
    const profile = new THREE.Shape();
    profile.moveTo(-depth / 2, 0);
    profile.lineTo(0, rise);
    profile.lineTo(depth / 2, 0);
    profile.closePath();
    const g = new THREE.ExtrudeGeometry(profile, { depth: width, bevelEnabled: false });
    // Profile drawn in (z, y): turn it so the extrusion runs along X.
    g.rotateY(Math.PI / 2);
    g.translate(-width / 2, y, z);
    add(g, SHADE.roof);
  };
  const slab = (w: number, d: number) => box(0, 0.02, 0, w, 0.04, d, SHADE.apron);

  if (style === "factory") {
    slab(1.24, 0.94);
    box(0, 0.25, 0.02, 1.1, 0.42, 0.78, SHADE.brick);
    box(0, 0.47, 0.02, 1.12, 0.03, 0.8, SHADE.wallDark);
    // Saw-tooth roof: three teeth, the steep glazed face to the front.
    const teeth = [-0.25, 0.02, 0.29];
    for (const z of teeth) {
      const profile = new THREE.Shape();
      profile.moveTo(-0.13, 0);
      profile.lineTo(-0.13, 0.2);
      profile.lineTo(0.13, 0);
      profile.closePath();
      const g = new THREE.ExtrudeGeometry(profile, { depth: 1.08, bevelEnabled: false });
      g.rotateY(Math.PI / 2);
      g.translate(-0.54, 0.485, z);
      add(g, SHADE.roof);
      box(0, 0.585, z - 0.135, 1.04, 0.16, 0.012, SHADE.glass);
    }
    // Tall chimney with its bands: the factory's silhouette from across the sea.
    pipe(0.42, 0.85, 0.3, 0.065, 1.5, SHADE.brick);
    for (const y of [0.9, 1.35]) {
      pipe(0.42, y, 0.3, 0.075, 0.04, SHADE.wallDark);
    }
    pipe(0.42, 1.61, 0.3, 0.08, 0.04, SHADE.grille);
    // Big glazed bays and a loading door on the front.
    for (const x of [-0.36, 0.36]) {
      box(x, 0.27, -0.38, 0.3, 0.26, 0.02, SHADE.glass);
      for (const dx of [-0.075, 0.075]) {
        box(x + dx, 0.27, -0.392, 0.012, 0.26, 0.012, SHADE.frame);
      }
    }
    box(0, 0.18, -0.385, 0.26, 0.32, 0.02, SHADE.door);
    box(0, 0.355, -0.39, 0.3, 0.03, 0.04, SHADE.frame);
    for (const z of [-0.2, 0.05, 0.3]) {
      box(-0.556, 0.3, z, 0.012, 0.14, 0.16, SHADE.glass);
    }
    box(-0.45, 0.09, 0.36, 0.14, 0.1, 0.14, SHADE.crate);
  } else if (style === "legacy-shack") {
    slab(0.92, 0.72);
    // Mismatched planks all round, a bit out of true.
    const shades = [SHADE.plank, SHADE.plankDark, SHADE.plankLight];
    for (let i = 0; i < 8; i++) {
      const x = -0.35 + i * 0.1;
      const h = 0.3 + (i % 3) * 0.02;
      box(x, 0.04 + h / 2, -0.25, 0.095, h, 0.02, shades[i % 3]!);
      box(x, 0.04 + h / 2, 0.25, 0.095, h, 0.02, shades[(i + 1) % 3]!);
    }
    box(-0.39, 0.2, 0, 0.02, 0.32, 0.5, SHADE.plankDark);
    box(0.39, 0.2, 0, 0.02, 0.32, 0.5, SHADE.plank);
    box(0, 0.2, 0, 0.76, 0.3, 0.48, SHADE.plankDark);
    // Corrugated tin roof, slipped and skewed.
    tilted([0.02, 0.4, 0.01], [0.88, 0.025, 0.64], [0.05, 0.08, 0.16], SHADE.tin);
    for (const x of [-0.28, -0.08, 0.12, 0.32]) {
      tilted([x, 0.42 - x * 0.16, 0.01], [0.02, 0.02, 0.64], [0.05, 0.08, 0.16], SHADE.steel);
    }
    // Boarded-up window, the door, and the nailed "docker-compose" sign.
    box(0.17, 0.22, -0.265, 0.16, 0.12, 0.012, SHADE.grille);
    tilted([0.17, 0.22, -0.275], [0.2, 0.025, 0.01], [0, 0, 0.5], SHADE.plankLight);
    tilted([0.17, 0.22, -0.278], [0.2, 0.025, 0.01], [0, 0, -0.5], SHADE.plankLight);
    box(-0.16, 0.16, -0.265, 0.14, 0.24, 0.012, SHADE.door);
    tilted([-0.05, 0.33, -0.275], [0.3, 0.06, 0.012], [0, 0, -0.06], SHADE.sign);
    // A rusty stovepipe and a barrel out the back.
    pipe(0.26, 0.5, 0.14, 0.022, 0.24, SHADE.wallDark);
    pipe(-0.34, 0.11, 0.31, 0.06, 0.14, SHADE.tin);
  } else if (style === "storefront") {
    slab(1, 0.88);
    box(0, 0.36, 0.06, 0.86, 0.64, 0.66, SHADE.wall);
    box(0, 0.7, 0.06, 0.9, 0.04, 0.7, SHADE.wallDark);
    // Flat roof with an AC unit.
    box(-0.2, 0.76, 0.2, 0.2, 0.08, 0.16, SHADE.steel);
    // Shop window and door on the ground floor, two windows above.
    box(-0.12, 0.17, -0.278, 0.48, 0.22, 0.012, SHADE.glass);
    box(0.28, 0.17, -0.278, 0.14, 0.26, 0.012, SHADE.door);
    for (const x of [-0.22, 0.2]) {
      box(x, 0.5, -0.278, 0.18, 0.14, 0.012, SHADE.glass);
      box(x, 0.43, -0.286, 0.2, 0.015, 0.02, SHADE.frame);
    }
    // Striped awning sloping out over the window, the shop sign above it.
    for (let i = 0; i < 6; i++) {
      tilted(
        [-0.33 + i * 0.084, 0.31, -0.35],
        [0.084, 0.015, 0.17],
        [-0.45, 0, 0],
        i % 2 === 0 ? SHADE.stripe : SHADE.sign,
      );
    }
    box(-0.12, 0.38, -0.285, 0.52, 0.06, 0.02, SHADE.sign);
    box(0.38, 0.08, -0.36, 0.08, 0.08, 0.08, SHADE.crate);
  } else if (style === "workshop") {
    slab(1, 0.9);
    box(0, 0.24, 0.05, 0.84, 0.4, 0.62, SHADE.wall);
    gable(0.44, 0.9, 0.7, 0.2, 0.05);
    // Lean-to on the side.
    box(0.5, 0.14, 0.12, 0.18, 0.2, 0.4, SHADE.wallDark);
    tilted([0.5, 0.25, 0.12], [0.2, 0.02, 0.44], [0, 0, -0.25], SHADE.tin);
    // Wide door, a gear on the gable, and the workbench out front.
    box(-0.12, 0.17, -0.265, 0.34, 0.28, 0.012, SHADE.door);
    box(-0.12, 0.32, -0.272, 0.38, 0.025, 0.02, SHADE.frame);
    const gear = new THREE.CylinderGeometry(0.07, 0.07, 0.02, 10);
    gear.rotateX(Math.PI / 2);
    gear.translate(0.24, 0.3, -0.27);
    add(gear, SHADE.steel);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      tilted(
        [0.24 + Math.cos(a) * 0.08, 0.3 + Math.sin(a) * 0.08, -0.27],
        [0.03, 0.03, 0.02],
        [0, 0, a],
        SHADE.steel,
      );
    }
    box(-0.12, 0.13, -0.38, 0.4, 0.02, 0.1, SHADE.bench);
    for (const x of [-0.3, 0.06]) {
      box(x, 0.075, -0.38, 0.02, 0.1, 0.08, SHADE.bench);
    }
    box(-0.2, 0.16, -0.38, 0.08, 0.04, 0.05, SHADE.grille);
  } else if (style === "watchtower") {
    slab(0.9, 0.9);
    // Four tapered steel legs, braced every storey.
    const foot = 0.27;
    const top = 0.11;
    const legTop = 1.55;
    const lean = Math.atan2(foot - top, legTop);
    const legLength = Math.hypot(foot - top, legTop);
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const mid = (foot + top) / 2;
      tilted(
        [sx * mid, 0.04 + legTop / 2, sz * mid],
        [0.04, legLength, 0.04],
        [-sz * lean, 0, sx * lean],
        SHADE.wallDark,
      );
    }
    for (const y of [0.45, 0.85, 1.2]) {
      const half = foot - ((foot - top) * (y - 0.04)) / legTop;
      for (const z of [-half, half]) {
        box(0, y, z, half * 2, 0.025, 0.025, SHADE.steel);
      }
      for (const x of [-half, half]) {
        box(x, y, 0, 0.025, 0.025, half * 2, SHADE.steel);
      }
    }
    // Lookout cabin, its rail, and the radar dish on a mast.
    box(0, 1.62, 0, 0.32, 0.03, 0.32, SHADE.grille);
    box(0, 1.73, 0, 0.24, 0.18, 0.24, SHADE.wall);
    for (const z of [-0.121, 0.121]) {
      box(0, 1.75, z, 0.2, 0.07, 0.006, SHADE.glass);
    }
    box(0, 1.835, 0, 0.28, 0.03, 0.28, SHADE.roof);
    pipe(0, 1.93, 0, 0.015, 0.16, SHADE.steel);
    tilted([0, 2.03, -0.02], [0.3, 0.12, 0.02], [0.35, 0, 0], SHADE.steel);
    pipe(0, 2.04, -0.08, 0.012, 0.08, SHADE.lamp);
    // The big dashboard screen at its foot.
    box(0.3, 0.3, -0.33, 0.34, 0.22, 0.03, SHADE.grille);
    box(0.3, 0.3, -0.347, 0.3, 0.18, 0.006, SHADE.screen);
    for (const x of [0.17, 0.43]) {
      box(x, 0.12, -0.33, 0.025, 0.16, 0.025, SHADE.wallDark);
    }
  } else if (style === "kiosk") {
    slab(0.84, 0.84);
    // Octagonal booth: plinth, open counter on posts, pointed roof with a bolt on top.
    pipe(0, 0.07, 0, 0.36, 0.06, SHADE.wallDark);
    pipe(0, 0.15, 0, 0.3, 0.12, SHADE.wall);
    pipe(0, 0.22, 0, 0.34, 0.025, SHADE.frame);
    pipe(0, 0.3, 0, 0.22, 0.14, SHADE.screen);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      pipe(Math.cos(a) * 0.3, 0.3, Math.sin(a) * 0.3, 0.014, 0.16, SHADE.steel);
    }
    pipe(0, 0.39, 0, 0.36, 0.025, SHADE.frame);
    const cap = new THREE.ConeGeometry(0.4, 0.26, 8);
    cap.rotateY(Math.PI / 8);
    cap.translate(0, 0.53, 0);
    add(cap, SHADE.stripe);
    tilted([0.015, 0.71, 0], [0.025, 0.1, 0.02], [0, 0, -0.5], SHADE.lamp);
    tilted([-0.01, 0.78, 0], [0.025, 0.1, 0.02], [0, 0, -0.5], SHADE.lamp);
    // Sign board on a pole, and a stool by the counter.
    pipe(0.38, 0.26, -0.18, 0.012, 0.44, SHADE.steel);
    box(0.38, 0.5, -0.18, 0.02, 0.1, 0.18, SHADE.sign);
    pipe(-0.18, 0.1, -0.36, 0.035, 0.12, SHADE.bench);
  } else if (style === "library") {
    slab(1.2, 0.9);
    // Stone hall on a stepped base, a columned portico and its pediment facing the street.
    box(0, 0.06, 0.02, 1.08, 0.04, 0.78, SHADE.stone);
    box(0, 0.1, -0.04, 1.0, 0.04, 0.7, SHADE.stone);
    box(0, 0.36, 0.06, 0.96, 0.48, 0.56, SHADE.wall);
    box(0, 0.615, 0.06, 1.0, 0.03, 0.6, SHADE.frame);
    gable(0.63, 0.98, 0.58, 0.16, 0.06);
    for (const x of [-0.3, -0.1, 0.1, 0.3]) {
      pipe(x, 0.36, -0.32, 0.035, 0.48, SHADE.frame);
    }
    box(0, 0.615, -0.29, 0.76, 0.03, 0.12, SHADE.frame);
    const front = new THREE.Shape();
    front.moveTo(-0.4, 0);
    front.lineTo(0, 0.18);
    front.lineTo(0.4, 0);
    front.closePath();
    const pediment = new THREE.ExtrudeGeometry(front, { depth: 0.12, bevelEnabled: false });
    pediment.translate(0, 0.63, -0.35);
    add(pediment, SHADE.roof);
    // Tall arched windows down each side and a big arched door.
    const arch = (x: number, z: number, w: number, h: number, shade: Shade, side = false) => {
      // Half-disc facing −Z, flat edge down; turned to face ±X on the side walls.
      const top = new THREE.CylinderGeometry(w / 2, w / 2, 0.012, 10, 1, false, 0, Math.PI);
      top.rotateX(Math.PI / 2);
      top.rotateZ(Math.PI / 2);
      if (side) {
        top.rotateY(Math.PI / 2);
      }
      top.translate(x, 0.14 + h, z);
      add(top, shade);
      box(x, 0.14 + h / 2, z, side ? 0.012 : w, h, side ? w : 0.012, shade);
    };
    arch(0, -0.226, 0.16, 0.22, SHADE.door);
    for (const x of [-0.36, 0.36]) {
      arch(x, -0.226, 0.12, 0.2, SHADE.glass);
    }
    for (const z of [-0.08, 0.14, 0.32]) {
      arch(-0.486, z, 0.11, 0.22, SHADE.glass, true);
      arch(0.486, z, 0.11, 0.22, SHADE.glass, true);
    }
  } else if (style === "switchboard") {
    slab(0.84, 0.84);
    // Narrow telephone exchange: tall block, a parapet, then a forest of antennas.
    box(0, 0.58, 0.04, 0.5, 1.08, 0.5, SHADE.wallDark);
    for (const y of [0.42, 0.66, 0.9]) {
      for (const x of [-0.12, 0.12]) {
        box(x, y, -0.215, 0.16, 0.13, 0.012, SHADE.glass);
      }
      box(0, y + 0.1, -0.215, 0.5, 0.02, 0.02, SHADE.frame);
    }
    box(0, 1.14, 0.04, 0.54, 0.04, 0.54, SHADE.frame);
    pipe(0, 1.38, 0.04, 0.018, 0.5, SHADE.steel);
    for (const y of [1.3, 1.44, 1.56]) {
      box(0, y, 0.04, 0.22 - (y - 1.3) * 0.4, 0.015, 0.015, SHADE.steel);
    }
    for (const [x, z, h] of [
      [-0.18, -0.12, 0.26],
      [0.19, 0.2, 0.34],
      [-0.17, 0.22, 0.18],
    ] as const) {
      pipe(x, 1.16 + h / 2, z, 0.012, h, SHADE.steel);
    }
    const dish = new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 3);
    dish.rotateX(-Math.PI / 2 - 0.4);
    dish.translate(0.18, 1.24, -0.12);
    add(dish, SHADE.steel);
    // Cables draped down the walls to the street.
    for (const [x, z, rot] of [
      [0.256, -0.08, 0.06],
      [0.256, 0.12, -0.05],
      [-0.256, 0.06, 0.04],
    ] as const) {
      tilted([x, 0.66, z], [0.012, 0.96, 0.012], [rot, 0, 0], SHADE.cable);
    }
    // Shop window: the switchboard, rows of patch lamps.
    box(0, 0.17, -0.215, 0.42, 0.22, 0.012, SHADE.grille);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        box(
          -0.15 + c * 0.06,
          0.1 + r * 0.06,
          -0.224,
          0.022,
          0.022,
          0.006,
          (r + c) % 3 === 0 ? SHADE.lamp : SHADE.cable,
        );
      }
    }
    box(0.32, 0.12, -0.12, 0.1, 0.14, 0.1, SHADE.grille);
  } else if (style === "relay-pylon") {
    slab(0.9, 0.9);
    // Tapered lattice pylon: four legs meeting near the top, X-bracing, two cross arms.
    const foot = 0.24;
    const legTop = 1.5;
    const top = 0.04;
    const lean = Math.atan2(foot - top, legTop);
    const legLength = Math.hypot(foot - top, legTop);
    const half = (y: number) => foot - ((foot - top) * (y - 0.04)) / legTop;
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const mid = (foot + top) / 2;
      tilted(
        [sx * mid, 0.04 + legTop / 2, sz * mid],
        [0.035, legLength, 0.035],
        [-sz * lean, 0, sx * lean],
        SHADE.wallDark,
      );
    }
    for (let i = 0; i < 4; i++) {
      const y0 = 0.1 + i * 0.33;
      const y = y0 + 0.165;
      const w = half(y) * 2;
      const angle = Math.atan2(0.33, w);
      const len = Math.hypot(0.33, w);
      for (const z of [-half(y), half(y)]) {
        tilted([0, y, z], [len, 0.018, 0.018], [0, 0, angle], SHADE.steel);
        tilted([0, y, z], [len, 0.018, 0.018], [0, 0, -angle], SHADE.steel);
      }
      for (const x of [-half(y), half(y)]) {
        tilted([x, y, 0], [0.018, 0.018, len], [angle, 0, 0], SHADE.steel);
        tilted([x, y, 0], [0.018, 0.018, len], [-angle, 0, 0], SHADE.steel);
      }
    }
    for (const [y, span] of [
      [1.12, 0.56],
      [1.38, 0.4],
    ] as const) {
      box(0, y, 0, span * 2, 0.035, 0.05, SHADE.wallDark);
      for (const x of [-span + 0.03, span - 0.03]) {
        pipe(x, y - 0.06, 0, 0.018, 0.08, SHADE.frame);
        // Glowing cables heading off to the other islands' pylons.
        tilted([x * 1.02, y - 0.3, 0.12], [0.014, 0.5, 0.014], [0.55, 0, 0], SHADE.cable);
      }
    }
    pipe(0, 1.6, 0, 0.012, 0.16, SHADE.steel);
    pipe(0, 1.69, 0, 0.022, 0.03, SHADE.lamp);
    // Control room at its base, door to the street.
    box(0, 0.16, -0.08, 0.34, 0.24, 0.26, SHADE.wall);
    box(0, 0.295, -0.08, 0.38, 0.03, 0.3, SHADE.roof);
    box(-0.07, 0.14, -0.215, 0.08, 0.16, 0.012, SHADE.door);
    box(0.08, 0.19, -0.215, 0.1, 0.07, 0.012, SHADE.screen);
  } else if (style === "relay-station") {
    slab(1, 1);
    // A big dish on a plinth, aimed at the sky over the street, and its tech hut.
    const [dx, dz] = [0.14, 0.12];
    box(dx, 0.09, dz, 0.42, 0.1, 0.42, SHADE.stone);
    pipe(dx, 0.5, dz, 0.05, 0.72, SHADE.wallDark);
    box(dx, 0.84, dz, 0.14, 0.08, 0.14, SHADE.grille);
    const tilt = -0.7;
    const centre = new THREE.Vector3(dx, 0.88, dz);
    const axis = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
    // Closed profile, underside out then bowl back in: both faces of the dish render.
    const bowl = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.001, 0),
        new THREE.Vector2(0.24, 0.04),
        new THREE.Vector2(0.44, 0.16),
        new THREE.Vector2(0.42, 0.17),
        new THREE.Vector2(0.23, 0.07),
        new THREE.Vector2(0.001, 0.035),
      ],
      14,
    );
    bowl.rotateX(tilt);
    bowl.translate(centre.x, centre.y, centre.z);
    add(bowl, SHADE.frame);
    const feed = centre.clone().addScaledVector(axis, 0.36);
    const arm = centre.clone().addScaledVector(axis, 0.19);
    tilted([arm.x, arm.y, arm.z], [0.02, 0.34, 0.02], [tilt, 0, 0], SHADE.steel);
    tilted([feed.x, feed.y, feed.z], [0.07, 0.07, 0.07], [tilt, 0, 0], SHADE.cable);
    // Counterweight behind the mount.
    tilted([dx, 0.8, dz + 0.12], [0.12, 0.1, 0.06], [tilt, 0, 0], SHADE.wallDark);
    // Hut at the street corner: door, status screen, beacon.
    box(-0.26, 0.17, -0.22, 0.34, 0.26, 0.28, SHADE.wall);
    box(-0.26, 0.315, -0.22, 0.38, 0.03, 0.32, SHADE.roof);
    box(-0.32, 0.15, -0.365, 0.08, 0.18, 0.012, SHADE.door);
    box(-0.18, 0.2, -0.365, 0.1, 0.07, 0.012, SHADE.screen);
    pipe(-0.16, 0.38, -0.14, 0.008, 0.1, SHADE.steel);
    pipe(-0.16, 0.44, -0.14, 0.02, 0.03, SHADE.lamp);
    // Conduit from the hut to the dish.
    box(-0.05, 0.06, -0.05, 0.36, 0.03, 0.03, SHADE.cable);
  } else if (style === "offshore-vault") {
    slab(0.96, 0.96);
    // A deck on stilts, a strongroom on it, a helipad on its roof.
    const leg = 0.36;
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      pipe(sx * leg, 0.21, sz * leg, 0.035, 0.36, SHADE.steel);
      // Beacon on each deck corner.
      pipe(sx * leg, 0.47, sz * leg, 0.02, 0.04, SHADE.lamp);
    }
    for (const z of [-leg, leg]) {
      tilted([0, 0.2, z], [0.02, 0.02, 0.84], [0, Math.PI / 2, 0.38], SHADE.wallDark);
    }
    for (const x of [-leg, leg]) {
      tilted([x, 0.2, 0], [0.02, 0.02, 0.84], [0.38, 0, 0], SHADE.wallDark);
    }
    box(0, 0.42, 0, 0.84, 0.06, 0.84, SHADE.wallDark);
    box(0, 0.455, -0.4, 0.84, 0.01, 0.03, SHADE.stripe);
    // Ladder down to the street.
    tilted([0.22, 0.24, -0.47], [0.12, 0.46, 0.015], [-0.25, 0, 0], SHADE.grille);
    // Strongroom: banded walls, round door with its wheel.
    box(0, 0.68, 0.04, 0.46, 0.46, 0.46, SHADE.steel);
    for (const y of [0.52, 0.84]) {
      box(0, y, 0.04, 0.48, 0.03, 0.48, SHADE.wallDark);
    }
    const door = new THREE.CylinderGeometry(0.13, 0.13, 0.02, 12);
    door.rotateX(Math.PI / 2);
    door.translate(0, 0.68, -0.195);
    add(door, SHADE.door);
    for (const angle of [0, Math.PI / 3, -Math.PI / 3]) {
      tilted([0, 0.68, -0.21], [0.18, 0.015, 0.012], [0, 0, angle], SHADE.frame);
    }
    // Helipad: a disc overhanging the roof, an H painted on it.
    pipe(0, 0.92, 0.04, 0.3, 0.02, SHADE.door, 14);
    pipe(0, 0.932, 0.04, 0.26, 0.006, SHADE.sign, 14);
    for (const x of [-0.07, 0.07]) {
      box(x, 0.937, 0.04, 0.03, 0.006, 0.2, SHADE.stripe);
    }
    box(0, 0.937, 0.04, 0.14, 0.006, 0.03, SHADE.stripe);
  } else {
    slab(1.3, 0.8);
    // Three silos joined by a catwalk, a conveyor climbing to it.
    for (const x of [-0.4, 0, 0.4]) {
      pipe(x, 0.5, 0.08, 0.17, 0.92, SHADE.steel);
      for (const y of [0.25, 0.55, 0.85]) {
        pipe(x, y, 0.08, 0.175, 0.02, SHADE.wallDark);
      }
      const cap = new THREE.ConeGeometry(0.17, 0.12, 8);
      cap.translate(x, 1.02, 0.08);
      add(cap, SHADE.roof);
    }
    box(0, 0.98, -0.12, 0.9, 0.03, 0.06, SHADE.grille);
    tilted([-0.2, 0.55, -0.27], [0.06, 0.02, 0.95], [-0.95, 0, 0], SHADE.grille);
    box(0.4, 0.12, -0.25, 0.26, 0.2, 0.16, SHADE.wall);
    box(0.4, 0.12, -0.335, 0.08, 0.14, 0.012, SHADE.door);
  }
  return build();
}
