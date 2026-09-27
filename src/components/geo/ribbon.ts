import * as THREE from "three";

/**
 * Flat ribbon of quads along a 3D polyline: roads, bridge decks and hover overlays.
 *
 * The width is always taken horizontally — the perpendicular of a segment
 * `(dx, dy, dz)` is the normalised `(dz, 0, -dx)` — so a deck that rises in Y keeps
 * its ground footprint. At interior points the two adjacent perpendiculars are
 * averaged and stretched by 1/cos of the half turn, like `offsetPolyline`, so the
 * edges stay parallel to the centreline and meet the pavement kerbs.
 *
 * The result is indexed with position + normal (+Y) + uv, matching the attribute
 * set of the built-in geometries it gets merged with (`mergeGeometries` refuses a
 * mix of indexed and non-indexed inputs, or heterogeneous attributes).
 * `u` runs in world units along the path, `v` is 0 on the right, 1 on the left.
 */
/** Sharper corners than this stretch no further (a 120° turn). */
const MAX_MITER = 2;

export function buildRibbon(
  points: [number, number, number][],
  width: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  // Drop repeated points: a zero-length segment has no direction.
  const path: [number, number, number][] = [];
  for (const p of points) {
    const prev = path[path.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1] && prev[2] === p[2]) {
      continue;
    }
    path.push(p);
  }

  const count = path.length;
  if (count < 2) {
    // Degenerate: an empty but structurally identical geometry, still mergeable.
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(0), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(0), 2));
    geometry.setIndex([]);
    return geometry;
  }

  // Per-segment horizontal perpendicular, plus the cumulative length used as `u`.
  const perp: [number, number][] = [];
  const along: number[] = [0];
  for (let i = 0; i < count - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    // A purely vertical step has no horizontal direction: reuse the previous one.
    const prev = perp[perp.length - 1];
    perp.push(len > 1e-6 ? [dz / len, -dx / len] : (prev ?? [1, 0]));
    along.push(along[i]! + Math.hypot(dx, b[1] - a[1], dz));
  }

  const half = width / 2;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const uvs = new Float32Array(count * 2 * 2);

  for (let i = 0; i < count; i++) {
    const segBefore = perp[i - 1];
    const segAfter = perp[i];
    let px: number;
    let pz: number;
    if (segBefore && segAfter) {
      px = segBefore[0] + segAfter[0];
      pz = segBefore[1] + segAfter[1];
      const len = Math.hypot(px, pz);
      if (len > 1e-6) {
        const miter = Math.min(
          MAX_MITER,
          1 / Math.max(1e-6, (px * segAfter[0] + pz * segAfter[1]) / len),
        );
        px = (px / len) * miter;
        pz = (pz / len) * miter;
      } else {
        // 180° turn back on itself: keep the incoming perpendicular.
        px = segBefore[0];
        pz = segBefore[1];
      }
    } else {
      const seg = segAfter ?? segBefore!;
      px = seg[0];
      pz = seg[1];
    }

    const p = path[i]!;
    const o = i * 6;
    positions[o] = p[0] + px * half;
    positions[o + 1] = p[1];
    positions[o + 2] = p[2] + pz * half;
    positions[o + 3] = p[0] - px * half;
    positions[o + 4] = p[1];
    positions[o + 5] = p[2] - pz * half;
    normals[o + 1] = 1;
    normals[o + 4] = 1;
    const u = along[i]!;
    const t = i * 4;
    uvs[t] = u;
    uvs[t + 1] = 1;
    uvs[t + 2] = u;
    uvs[t + 3] = 0;
  }

  // Two triangles per span, wound CCW seen from above so the +Y normal faces the camera.
  const index: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}
