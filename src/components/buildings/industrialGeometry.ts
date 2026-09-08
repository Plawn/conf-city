import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type IndustrialStyle =
  | "warehouse"
  | "sheds"
  | "datacenter"
  | "depot"
  | "cold-storage"
  | "terminal"
  | "containers";

/**
 * Vertex colours, as linear RGB triplets rather than the grey levels this file
 * started with.
 *
 * `NodeMesh` multiplies the whole model by one type/biome tint, so a model whose
 * every part is the same neutral grey comes out as a single flat block of that
 * tint — which is exactly how the datastores and caches read from a normal camera
 * distance. Giving each part its own slightly-hued base (cold zinc on a roof, warm
 * concrete on a plinth, painted steel on a door) survives the multiply: the type
 * hue still dominates, but the roof, the walls and the apron no longer collapse
 * into one another. They stay desaturated on purpose — the tint has to win.
 */
const SHADE = {
  apron: [0.44, 0.44, 0.47],
  wall: [0.86, 0.85, 0.82],
  wallDark: [0.57, 0.58, 0.62],
  roof: [0.62, 0.65, 0.72],
  roofDeck: [0.6, 0.62, 0.66],
  parapet: [0.68, 0.69, 0.71],
  unit: [0.5, 0.52, 0.58],
  grille: [0.24, 0.25, 0.28],
  vent: [0.7, 0.72, 0.76],
  door: [0.22, 0.23, 0.27],
  doorRib: [0.4, 0.41, 0.45],
  lintel: [0.93, 0.92, 0.9],
  post: [0.6, 0.61, 0.64],
  duct: [0.3, 0.31, 0.35],
  rail: [0.75, 0.76, 0.8],
  crate: [0.66, 0.6, 0.5],
  crateDark: [0.5, 0.45, 0.38],
  containerA: [0.74, 0.7, 0.64],
  containerB: [0.56, 0.58, 0.62],
  stack: [0.9, 0.89, 0.86],
} as const satisfies Record<string, readonly [number, number, number]>;

type Shade = readonly [number, number, number];

/** One merged, vertex-coloured mesh per model. Dimensions fit the existing plots at every yaw. */
export function industrialGeometry(style: IndustrialStyle): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, shade: Shade) => {
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
    parts.push(g);
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, shade: Shade) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    add(g, shade);
  };
  /** A vertical cylinder — pipes, silos, the stair drum. Kept to 8 sides: this is a low-poly kit. */
  const pipe = (x: number, y: number, z: number, r: number, h: number, shade: Shade) => {
    const g = new THREE.CylinderGeometry(r, r, h, 8);
    g.translate(x, y, z);
    add(g, shade);
  };
  const roof = (z: number, depth: number, shed = false) => {
    const profile = new THREE.Shape();
    profile.moveTo(-0.64, 0.47);
    profile.lineTo(shed ? 0.46 : 0, 0.67);
    profile.lineTo(0.64, 0.47);
    profile.closePath();
    const g = new THREE.ExtrudeGeometry(profile, { depth, bevelEnabled: false });
    g.translate(0, 0, z - depth / 2);
    add(g, SHADE.roof);
  };
  /** The ridge cap and the gutter each side: what stops a pitched roof reading as a wedge. */
  const roofTrim = (z: number, depth: number, shed: boolean) => {
    // `box` centres on z, unlike ExtrudeGeometry which starts there — the trim
    // takes the roof's own centre, or it hangs half a bay off the back apron
    // and the building no longer fits its plot.
    box(shed ? 0.46 : 0, 0.678, z, 0.07, 0.022, depth * 0.99, SHADE.parapet);
    for (const x of [-0.638, 0.638]) {
      box(x, 0.463, z, 0.035, 0.028, depth * 0.99, SHADE.parapet);
    }
  };

  box(0, 0.025, 0, 1.36, 0.05, 0.95, SHADE.apron);
  const containers = style === "containers";
  box(0, 0.265, 0.02, 1.25, 0.43, 0.78, containers ? SHADE.wallDark : SHADE.wall);
  // A band along the top of the wall, under the roof line: reads as a cornice from above
  // and breaks the single flat face the wall used to be.
  box(0, 0.462, 0.02, 1.27, 0.03, 0.8, SHADE.wallDark);

  if (style === "warehouse" || style === "depot") {
    roof(0.02, 0.84);
    roofTrim(0.02, 0.84, false);
    // Ridge vents down the spine, and the ribs of the roof panels either side.
    for (const z of [-0.24, 0.02, 0.28]) {
      box(0, 0.685, z, 0.14, 0.04, 0.12, SHADE.vent);
    }
    for (const x of [-0.44, -0.22, 0.22, 0.44]) {
      box(x, 0.55 + (0.64 - Math.abs(x)) * 0.0, 0.02, 0.012, 0.012, 0.82, SHADE.roofDeck);
    }
  } else if (style === "sheds" || style === "terminal") {
    for (const z of [-0.26, 0.02, 0.3]) {
      roof(z, 0.27, true);
      roofTrim(z, 0.27, true);
    }
    // The north-light glazing every saw-tooth roof is built for.
    for (const z of [-0.26, 0.02, 0.3]) {
      box(-0.13, 0.575, z - 0.135, 0.5, 0.012, 0.24, SHADE.grille);
    }
  } else {
    box(0, 0.495, 0.02, 1.29, 0.055, 0.83, SHADE.roofDeck);
    // Parapet round the flat roof — the plant on it should sit in something.
    for (const x of [-0.633, 0.633]) {
      box(x, 0.545, 0.02, 0.025, 0.045, 0.83, SHADE.parapet);
    }
    for (const z of [-0.375, 0.415]) {
      box(0, 0.545, z, 1.29, 0.045, 0.025, SHADE.parapet);
    }
    for (const x of [-0.42, 0, 0.42]) {
      box(x, 0.57, 0.09, 0.23, 0.12, 0.25, SHADE.unit);
      box(x, 0.635, 0.09, 0.17, 0.012, 0.18, SHADE.grille);
      for (const z of [0.04, 0.09, 0.14]) {
        box(x, 0.645, z, 0.16, 0.012, 0.018, SHADE.vent);
      }
      // Each unit sits on a curb and is fed by a duct running back to the roof.
      box(x, 0.518, 0.09, 0.26, 0.03, 0.28, SHADE.duct);
      box(x, 0.55, -0.12, 0.06, 0.06, 0.16, SHADE.duct);
    }
    // Exhaust stacks and the stair head, off to one corner.
    for (const z of [-0.28, -0.17]) {
      pipe(0.5, 0.575, z, 0.028, 0.11, SHADE.duct);
    }
    box(-0.5, 0.575, -0.24, 0.19, 0.11, 0.19, SHADE.stack);
  }

  // Recessed roller doors, lintels and a loading apron make the front legible from above.
  for (const x of [-0.41, 0, 0.41]) {
    box(x, 0.2, -0.379, 0.26, 0.29, 0.026, SHADE.door);
    box(x, 0.356, -0.39, 0.29, 0.035, 0.05, SHADE.lintel);
    for (const y of [0.11, 0.17, 0.23, 0.29]) {
      box(x, y, -0.397, 0.23, 0.013, 0.009, SHADE.doorRib);
    }
    // The dock bumpers and the painted bay edge at the foot of each door.
    for (const dx of [-0.115, 0.115]) {
      box(x + dx, 0.075, -0.404, 0.03, 0.05, 0.02, SHADE.grille);
    }
    box(x, 0.055, -0.44, 0.28, 0.014, 0.06, SHADE.lintel);
  }
  for (const x of [-0.61, -0.2, 0.2, 0.61]) {
    box(x, 0.265, -0.385, 0.027, 0.42, 0.038, SHADE.post);
  }
  for (const z of [-0.23, 0, 0.23]) {
    box(0.633, 0.31, z, 0.018, 0.09, 0.14, SHADE.grille);
  }
  // Service side: a downpipe at each rear corner and a handrail along the apron.
  for (const x of [-0.6, 0.6]) {
    pipe(x, 0.25, 0.38, 0.016, 0.44, SHADE.duct);
  }
  for (const x of [-0.5, -0.17, 0.17, 0.5]) {
    box(x, 0.115, 0.455, 0.02, 0.13, 0.02, SHADE.rail);
  }
  box(0, 0.175, 0.455, 1.05, 0.016, 0.016, SHADE.rail);

  if (containers) {
    // Two stacks on the roof, each course offset, so the silhouette is a stack of
    // boxes rather than one slab. Alternating shades read as different containers.
    const stacks: Array<[number, number, Shade]> = [
      [-0.35, 0.06, SHADE.containerA],
      [0.12, 0.06, SHADE.containerB],
    ];
    for (const [x, z, shade] of stacks) {
      box(x, 0.585, z, 0.38, 0.14, 0.63, shade);
      box(
        x,
        0.725,
        z,
        0.38,
        0.14,
        0.63,
        shade === SHADE.containerA ? SHADE.containerB : SHADE.containerA,
      );
      // Corrugation: three ribs a side, and the corner castings top and bottom.
      for (const rz of [-0.2, 0, 0.2]) {
        box(x, 0.655, z + rz, 0.39, 0.24, 0.02, SHADE.wallDark);
      }
    }
    // Ground-level containers waiting on the apron.
    box(-0.52, 0.105, 0.3, 0.3, 0.11, 0.19, SHADE.containerB);
    box(0.5, 0.105, 0.31, 0.26, 0.11, 0.17, SHADE.containerA);
  }
  if (style === "cold-storage") {
    box(-0.48, 0.59, 0.27, 0.18, 0.2, 0.18, SHADE.stack);
    // Refrigerant pipework running down the gable, the one thing that says "cold".
    for (const z of [0.2, 0.34]) {
      pipe(-0.585, 0.36, z, 0.02, 0.2, SHADE.vent);
    }
  }
  if (style === "warehouse" || style === "sheds" || style === "terminal") {
    // Palletised goods on the apron: small, but they give the plot a scale.
    box(-0.55, 0.085, 0.28, 0.16, 0.07, 0.16, SHADE.crate);
    box(-0.55, 0.145, 0.28, 0.14, 0.05, 0.14, SHADE.crateDark);
    box(0.54, 0.085, 0.33, 0.14, 0.07, 0.14, SHADE.crateDark);
  }

  const merged = mergeGeometries(parts)!;
  for (const part of parts) {
    part.dispose();
  }
  merged.computeBoundingBox();
  return merged;
}
