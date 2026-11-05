import { clamp01 } from "../lib/math";
import { fnv1a, mulberry32 } from "../lib/random";

/** Replay arrivals: pure functions of a building's presence (0..1) or rise age. */

/** easeOutBack strength: the height overshoots by ~7 % before settling. */
const BACK = 1.4;

/** [footprint, height] scale while a building rises: shoots up narrow, overshoots, squashes back to 1. */
export function buildingRise(presence: number): [number, number] {
  const p = clamp01(presence);
  if (p >= 1) {
    return [1, 1];
  }
  const q = p - 1;
  const y = 1 + (BACK + 1) * q * q * q + BACK * q * q;
  const widen = 1 - (1 - p) ** 3;
  const squash = Math.sin(Math.PI * clamp01((p - 0.7) / 0.3));
  return [(0.55 + 0.45 * widen) * (1 + 0.07 * squash), y];
}

/** Seconds the construction dust lingers after a building starts rising. */
export const DUST_SEC = 1.3;

export interface DustPuff {
  angle: number;
  reach: number;
  rise: number;
  size: number;
}

/** Same seed, same dust ring. */
export function dustPuffs(seed: string, count: number): DustPuff[] {
  const rand = mulberry32(fnv1a(`${seed}#dust`));
  return Array.from({ length: count }, (_, i) => ({
    angle: ((i + rand() * 0.6) / count) * Math.PI * 2,
    reach: 0.7 + rand() * 0.6,
    rise: 0.15 + rand() * 0.35,
    size: 0.5 + rand() * 0.5,
  }));
}

/** Puff offset (footprint-relative) and scale `age` seconds into the rise; scale 0 once settled. */
export function dustAt(
  p: DustPuff,
  age: number,
  out: { x: number; y: number; z: number; scale: number },
) {
  const k = age / DUST_SEC;
  if (k <= 0 || k >= 1) {
    out.scale = 0;
    return out;
  }
  const r = 0.45 + p.reach * (1 - (1 - k) ** 2);
  out.x = Math.cos(p.angle) * r;
  out.z = Math.sin(p.angle) * r;
  out.y = 0.05 + p.rise * k;
  out.scale = p.size * 0.32 * Math.sin(Math.PI * k) ** 0.6;
  return out;
}
