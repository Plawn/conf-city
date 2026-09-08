import * as THREE from "three";
import type { Vec2 } from "../../layout/types";

/**
 * Flat caps and vertical walls from ground-plane loops, in the attribute set
 * `mergeGeometries` needs (indexed position / normal / uv), so a whole city's
 * pavements can be one draw call.
 *
 * A `THREE.Shape` lives in XY: the loop's world `z` is mirrored on the way in
 * and the `-π/2` rotation around X puts it back — the trick `IslandMesh` and
 * `ZoneSlab` already rely on. No holes: earcut degrades when a hole touches
 * the contour, which is exactly what a junction cut by its own arms produces,
 * so callers only ever hand over simple polygons.
 */

/** A flat polygon at height `y`, facing up. */
export function polygonCap(loop: Vec2[], y: number): THREE.BufferGeometry | null {
  if (loop.length < 3) {
    return null;
  }
  const shape = new THREE.Shape();
  const first = loop[0]!;
  shape.moveTo(first[0], -first[1]);
  for (let i = 1; i < loop.length; i++) {
    const p = loop[i]!;
    shape.lineTo(p[0], -p[1]);
  }
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}

/**
 * A vertical band along `chain` from `y0` to `y1`; `closed` joins the last
 * point back to the first. Normals face the right of the chain's direction,
 * but the material is drawn double-sided anyway.
 */
export function loopWall(
  chain: Vec2[],
  y0: number,
  y1: number,
  closed: boolean,
): THREE.BufferGeometry | null {
  const n = chain.length;
  if (n < 2) {
    return null;
  }
  const count = closed ? n + 1 : n;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const uvs = new Float32Array(count * 2 * 2);
  let along = 0;
  for (let i = 0; i < count; i++) {
    const p = chain[i % n]!;
    const back = chain[(i - 1 + n) % n]!;
    const ahead = chain[(i + 1) % n]!;
    const ref = closed || i + 1 < n ? ahead : p;
    const prev = closed || i > 0 ? back : p;
    const dx = ref[0] - prev[0];
    const dz = ref[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;
    if (i > 0) {
      along += Math.hypot(p[0] - back[0], p[1] - back[1]);
    }
    const o = i * 6;
    positions[o] = p[0];
    positions[o + 1] = y0;
    positions[o + 2] = p[1];
    positions[o + 3] = p[0];
    positions[o + 4] = y1;
    positions[o + 5] = p[1];
    normals[o] = nx;
    normals[o + 2] = nz;
    normals[o + 3] = nx;
    normals[o + 5] = nz;
    const t = i * 4;
    uvs[t] = along;
    uvs[t + 1] = 0;
    uvs[t + 2] = along;
    uvs[t + 3] = 1;
  }
  const index: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}
