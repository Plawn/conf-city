import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PropKind } from "../../domain/biome";

/**
 * The vegetation, built rather than imported.
 *
 * Kenney's Nature Kit would have done the job, but its models carry their own
 * baked colours, and a biome here *is* a palette: `canopy` / `trunk` / `rock` are
 * already declared per biome in `domain/biome.ts`. A downloaded tree would be the
 * same green on the tundra as on the meadow, or need a tint that fights its
 * texture. Generating them costs a few dozen triangles each and lets every island
 * grow its own colours — the same trade `industrialGeometry` makes.
 *
 * Each is centred on the origin with its base at y = 0 and a height near 1, so
 * one instanced draw call per kind carries position, yaw and scale and nothing
 * else. Segment counts stay low on purpose: these are drawn a few hundred at a
 * time and read at 20 metres.
 */
export interface PropPalette {
  canopy: string;
  trunk: string;
  rock: string;
}

function coloured(geometry: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) {
    geometry.dispose();
  }
  const c = new THREE.Color(hex);
  const count = g.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Slightly darker or lighter than the palette colour, so two stacked masses separate. */
function shade(hex: string, k: number): string {
  return `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
}

function trunk(radius: number, height: number, hex: string): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius * 0.8, radius, height, 6);
  g.translate(0, height / 2, 0);
  return coloured(g, hex);
}

export function propGeometry(kind: PropKind, palette: PropPalette): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const { canopy, rock } = palette;

  if (kind === "tree") {
    // Broadleaf: two offset spheres on a short trunk, faceted low enough to read
    // as a low-poly kit rather than a smooth ball.
    parts.push(trunk(0.09, 0.42, palette.trunk));
    const a = new THREE.IcosahedronGeometry(0.34, 0);
    a.translate(0, 0.66, 0);
    parts.push(coloured(a, canopy));
    const b = new THREE.IcosahedronGeometry(0.24, 0);
    b.scale(1, 0.85, 1);
    b.translate(0.11, 0.92, -0.06);
    parts.push(coloured(b, shade(canopy, 1.18)));
  } else if (kind === "pine") {
    parts.push(trunk(0.07, 0.3, palette.trunk));
    // Three cones, each narrower than the one below: the classic conifer stack.
    const tiers: Array<[number, number, number]> = [
      [0.34, 0.42, 0.36],
      [0.26, 0.36, 0.66],
      [0.17, 0.3, 0.92],
    ];
    for (const [r, h, y] of tiers) {
      const cone = new THREE.ConeGeometry(r, h, 7);
      cone.translate(0, y + h / 2, 0);
      parts.push(coloured(cone, shade(canopy, 0.9 + y * 0.22)));
    }
  } else if (kind === "palm") {
    // A leaning trunk with fronds fanned round the top — the lean is what makes
    // a row of palms look planted rather than stamped.
    const stem = new THREE.CylinderGeometry(0.045, 0.075, 0.95, 6);
    stem.translate(0, 0.47, 0);
    stem.rotateZ(0.12);
    parts.push(coloured(stem, palette.trunk));
    for (let i = 0; i < 6; i++) {
      const frond = new THREE.ConeGeometry(0.1, 0.5, 4);
      frond.scale(1, 1, 0.32);
      frond.rotateZ(Math.PI / 2);
      frond.rotateX(0.35);
      frond.translate(0.26, 0.94, 0);
      frond.rotateY((i / 6) * Math.PI * 2);
      parts.push(coloured(frond, shade(canopy, i % 2 === 0 ? 1 : 1.15)));
    }
    const crown = new THREE.IcosahedronGeometry(0.09, 0);
    crown.translate(0.06, 0.98, 0);
    parts.push(coloured(crown, palette.trunk));
  } else if (kind === "rock") {
    // A boulder and its chip: irregular scaling on a low icosahedron is enough,
    // and it keeps the whole prop under 30 triangles.
    const a = new THREE.IcosahedronGeometry(0.4, 0);
    a.scale(1, 0.62, 0.82);
    a.rotateY(0.6);
    a.translate(0, 0.2, 0);
    parts.push(coloured(a, rock));
    const b = new THREE.IcosahedronGeometry(0.2, 0);
    b.scale(1, 0.7, 1);
    b.translate(0.32, 0.1, 0.16);
    parts.push(coloured(b, shade(rock, 1.2)));
  } else {
    // Tuft: three blades leaning apart. Flat, cheap, and it breaks bare ground.
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.ConeGeometry(0.11, 0.34, 4);
      blade.scale(1, 1, 0.4);
      blade.translate(0, 0.17, 0);
      blade.rotateZ(-0.3 + i * 0.3);
      blade.rotateY(i * 1.1);
      parts.push(coloured(blade, shade(canopy, 0.92 + i * 0.12)));
    }
  }

  const merged = mergeGeometries(parts)!;
  for (const part of parts) {
    part.dispose();
  }
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}
