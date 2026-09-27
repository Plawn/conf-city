import * as THREE from "three";
import type { ShoreField } from "../../layout/shore";
import { fnv1a, mulberry32 } from "../../lib/random";

/**
 * The two lookup textures the water shader reads: the baked distance-to-shore
 * field, and a tileable ripple slope map. Both are data, not images — nothing to
 * load, nothing in `public/`.
 */

/**
 * `ShoreField` → one-channel byte texture. Clamp-to-edge is what turns the
 * field's open-sea border into "open sea everywhere beyond the grid".
 */
export function shoreTexture(field: ShoreField): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    field.data,
    field.size,
    field.size,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Texels per side of the ripple tile. A power of two: WebGL wants it for repeat + mipmaps. */
const RIPPLE_SIZE = 128;
/** Waves summed into the tile. */
const RIPPLE_WAVES = 8;

/**
 * Tileable ripple map: RG = slopes, B = height. One sample supplies both
 * shading normals and the crest mask, so foam needs no additional noise lookup.
 *
 * The height field is a sum of sines with **integer** wave numbers over the
 * tile, so it repeats exactly at the tile's edge — no seam, no blending trick.
 * The slope is analytic (the derivative of the same sum), which is what the
 * shader wants: it tilts the shading normal, it never reconstructs a height.
 * Directions and phases come from the layout's seeded PRNG, so the sea looks
 * the same on every machine.
 */
function bakeRipples(): THREE.DataTexture {
  const rand = mulberry32(fnv1a("conf-city-water"));
  const waves: { kx: number; ky: number; amp: number; phase: number }[] = [];
  for (let i = 0; i < RIPPLE_WAVES; i++) {
    // Wave numbers 2..7 per tile: below 2 the tile shows as a blob, above 7 the
    // texture cannot hold the wave at this resolution once it is scaled down.
    const k = 2 + Math.floor(rand() * 6);
    const angle = rand() * Math.PI * 2;
    const kx = Math.round(Math.cos(angle) * k);
    const ky = Math.round(Math.sin(angle) * k);
    if (kx === 0 && ky === 0) {
      continue;
    }
    waves.push({ kx, ky, amp: 1 / Math.hypot(kx, ky), phase: rand() * Math.PI * 2 });
  }

  const slope = new Float32Array(RIPPLE_SIZE * RIPPLE_SIZE * 3);
  let peak = 0;
  let heightPeak = 0;
  for (let y = 0; y < RIPPLE_SIZE; y++) {
    const v = y / RIPPLE_SIZE;
    for (let x = 0; x < RIPPLE_SIZE; x++) {
      const u = x / RIPPLE_SIZE;
      let sx = 0;
      let sy = 0;
      let height = 0;
      for (const w of waves) {
        const phase = 2 * Math.PI * (w.kx * u + w.ky * v) + w.phase;
        const c = w.amp * Math.cos(phase);
        sx += c * w.kx;
        sy += c * w.ky;
        height += w.amp * Math.sin(phase);
      }
      const i = (y * RIPPLE_SIZE + x) * 3;
      slope[i] = sx;
      slope[i + 1] = sy;
      slope[i + 2] = height;
      peak = Math.max(peak, Math.abs(sx), Math.abs(sy));
      heightPeak = Math.max(heightPeak, Math.abs(height));
    }
  }

  const data = new Uint8Array(RIPPLE_SIZE * RIPPLE_SIZE * 4);
  for (let i = 0; i < RIPPLE_SIZE * RIPPLE_SIZE; i++) {
    data[i * 4] = Math.round(127.5 + (slope[i * 3]! / peak) * 127.5);
    data[i * 4 + 1] = Math.round(127.5 + (slope[i * 3 + 1]! / peak) * 127.5);
    data[i * 4 + 2] = Math.round(127.5 + (slope[i * 3 + 2]! / heightPeak) * 127.5);
    data[i * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(
    data,
    RIPPLE_SIZE,
    RIPPLE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let ripples: THREE.DataTexture | null = null;

/** The one ripple tile of the app, baked on first use and never disposed. */
export function rippleTexture(): THREE.DataTexture {
  if (!ripples) {
    ripples = bakeRipples();
  }
  return ripples;
}
