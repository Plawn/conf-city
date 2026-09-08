import type { Vec2 } from "./types";

/**
 * Distance-to-shore field: how far every point of the sea is from the nearest
 * island edge, baked once per layout into a small grid the water shader samples.
 *
 * The shore is the *only* thing the water needs to know about the world, and the
 * world never moves between two layouts, so a CPU bake beats any per-fragment
 * search: the shader pays one texture read, however many islands there are.
 *
 * Distances are unsigned. Under an island the water is hidden by the slab (its
 * top is at y = 0, its underside at −1.2, the sea at −0.6), so the inside of an
 * outline is never seen and needs no sign. `IslandMesh`'s bevel stops well above
 * the waterline, which therefore sits exactly on the outline: distance 0 *is* the
 * water's edge.
 */

export interface ShoreField {
  /** Texels per axis (square). */
  size: number;
  /** World `[x, z]` of the centre of texel (0, 0). */
  originX: number;
  originZ: number;
  /** World size of one texel. */
  cell: number;
  /** Distance at which the field saturates: from here on it is open sea. */
  reach: number;
  /** `size²` bytes, row-major on Z then X: `distance / reach × 255`, clamped. */
  data: Uint8Array;
}

/** Above this resolution the bake stops being "a few milliseconds". */
const MAX_SIZE = 512;
/** Below this cell size the bilinear filter already hides the steps. */
const MIN_CELL = 0.5;

/** Distance from `(px, pz)` to the segment `a–b`. */
function segmentDistance(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a[0] + t * dx - px;
  const ez = a[1] + t * dz - pz;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Bakes the field for a set of closed outlines (world coordinates).
 *
 * The grid covers the outlines' bounding box plus `reach` on every side, so its
 * border texels are guaranteed to be open sea — a clamp-to-edge sampler then
 * returns "open sea" for the whole ocean beyond, at no cost.
 *
 * Work is driven by the segments, not the texels: each edge only visits the
 * texels within `reach` of its own bounding box. A hundred edges per island over
 * a band a few cells wide is far cheaper than testing every texel against every
 * edge, and it is what keeps the bake off the frame budget when a discovered
 * city redraws the world.
 */
export function buildShoreField(outlines: Vec2[][], reach: number): ShoreField {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const outline of outlines) {
    for (const [x, z] of outline) {
      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (z < minZ) {
        minZ = z;
      }
      if (z > maxZ) {
        maxZ = z;
      }
    }
  }
  if (!Number.isFinite(minX)) {
    // No shore at all: a single open-sea texel.
    return { size: 1, originX: 0, originZ: 0, cell: 1, reach, data: new Uint8Array([255]) };
  }

  minX -= reach;
  minZ -= reach;
  maxX += reach;
  maxZ += reach;
  const extent = Math.max(maxX - minX, maxZ - minZ);
  const cell = Math.max(MIN_CELL, extent / MAX_SIZE);
  // One texel more than the extent needs, so the `reach` margin is fully
  // covered and the border row really is open sea (the tests check this).
  const size = Math.ceil(extent / cell) + 1;
  // Centre the square grid on the (possibly oblong) bounding box.
  const originX = (minX + maxX) / 2 - ((size - 1) * cell) / 2;
  const originZ = (minZ + maxZ) / 2 - ((size - 1) * cell) / 2;

  // Exact distances first, quantised once at the end: a byte per texel would
  // otherwise round at every `min`.
  const dist = new Float32Array(size * size).fill(reach);
  const band = Math.ceil(reach / cell);

  for (const outline of outlines) {
    const n = outline.length;
    if (n < 2) {
      continue;
    }
    for (let i = 0; i < n; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % n]!;
      const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - originX) / cell) - band);
      const x1 = Math.min(size - 1, Math.ceil((Math.max(a[0], b[0]) - originX) / cell) + band);
      const z0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - originZ) / cell) - band);
      const z1 = Math.min(size - 1, Math.ceil((Math.max(a[1], b[1]) - originZ) / cell) + band);
      for (let iz = z0; iz <= z1; iz++) {
        const pz = originZ + iz * cell;
        const row = iz * size;
        for (let ix = x0; ix <= x1; ix++) {
          const d = segmentDistance(originX + ix * cell, pz, a, b);
          if (d < dist[row + ix]!) {
            dist[row + ix] = d;
          }
        }
      }
    }
  }

  const data = new Uint8Array(size * size);
  const scale = 255 / reach;
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.min(255, Math.round(dist[i]! * scale));
  }
  return { size, originX, originZ, cell, reach, data };
}

/** Bilinear-free lookup at world `(x, z)`, in world units — for tests and tooling. */
export function sampleShore(field: ShoreField, x: number, z: number): number {
  const ix = Math.min(field.size - 1, Math.max(0, Math.round((x - field.originX) / field.cell)));
  const iz = Math.min(field.size - 1, Math.max(0, Math.round((z - field.originZ) / field.cell)));
  return (field.data[iz * field.size + ix]! / 255) * field.reach;
}
