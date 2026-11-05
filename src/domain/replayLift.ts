import { clamp01 } from "../lib/math";

/** How deep an island starts under the sea. */
export const ISLAND_DROP = 4;
/** How high above its deck a cloud service starts. */
export const CLOUD_DROP = 14;

/** Overshoot past the resting place, as a fraction of the drop: an island bobs up, a cloud dips. */
const SETTLE = 0.06;

/**
 * Height offset of a replayed city from its resting place at `presence` (0..1):
 * islands emerge from the sea, cloud services come down from the sky. Eased out with a
 * small overshoot, so both bob once and settle; shared by the city and its blasts.
 */
export function cityLift(presence: number, cloud: boolean): number {
  const p = clamp01(presence);
  const k = (1 - p) ** 3 - SETTLE * Math.sin(Math.PI * p) ** 2 * p;
  return cloud ? CLOUD_DROP * k : -ISLAND_DROP * k;
}
