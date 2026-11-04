import { clamp01 } from "../lib/math";

/** How deep an island starts under the sea. */
export const ISLAND_DROP = 4;
/** How high above its deck a cloud service starts. */
export const CLOUD_DROP = 14;

/**
 * Height offset of a replayed city from its resting place at `presence` (0..1):
 * islands emerge from the sea, cloud services come down from the sky. Eased out,
 * so both settle gently; shared by the city and its blasts.
 */
export function cityLift(presence: number, cloud: boolean): number {
  const k = (1 - clamp01(presence)) ** 3;
  return cloud ? CLOUD_DROP * k : -ISLAND_DROP * k;
}
