import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Linear RGB of one part of a vertex-coloured model. */
export type Shade = readonly [number, number, number];

/** `geometry` de-indexed (the indexed original disposed) with every vertex painted `shade`. */
export function colourGeometry(geometry: THREE.BufferGeometry, shade: Shade): THREE.BufferGeometry {
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
  return g;
}

/**
 * The primitive kit of the generated models: coloured parts collected, then merged
 * into one buffer by `build`, which disposes the parts, starts over and applies `finish`.
 */
export function createBuilder({
  sides = 8,
  finish,
}: {
  /** Default side count of `pipe`: these are low-poly kits. */
  sides?: number;
  finish: (merged: THREE.BufferGeometry) => void;
}) {
  let parts: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, shade: Shade) => {
    parts.push(colourGeometry(geometry, shade));
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, shade: Shade) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    add(g, shade);
  };
  /** A vertical cylinder centred on (x, y, z). */
  const pipe = (
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    shade: Shade,
    count = sides,
  ) => {
    const g = new THREE.CylinderGeometry(r, r, h, count);
    g.translate(x, y, z);
    add(g, shade);
  };
  const build = (): THREE.BufferGeometry => {
    const merged = mergeGeometries(parts, false);
    for (const p of parts) {
      p.dispose();
    }
    parts = [];
    if (!merged) {
      throw new Error("coloured geometry: parts do not share an attribute set");
    }
    finish(merged);
    return merged;
  };
  return { add, box, pipe, build };
}
