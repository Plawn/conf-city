/** Full turn in radians. */
export const TAU = Math.PI * 2;

/** Geometric tolerance shared by the layout and road geometry. */
export const EPS = 1e-9;

/** Golden angle in radians, for sunflower (Vogel) spirals. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hermite ramp of `x` between `edge0` and `edge1`, like GLSL `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
