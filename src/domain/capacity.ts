import type { MetricSnapshot } from "./types";

/**
 * "The land is RAM": one lattice lot of island per `LOT_MB` of machine memory,
 * and a building fills its lot once its service uses that much. Island size and
 * building footprints share the unit, so a crowded island reads as an
 * overcommitted machine.
 */

/** Machine memory worth one lattice lot (`PITCH²`) of island. */
export const LOT_MB = 1024;
/**
 * Largest rendered ground radius of a building: half a lattice cell minus half a
 * street and its pavement (3 − 0.5 − 0.35), less a hair so the kerb stays visible.
 * Wider than the layout's `footprintRadius`, which only shapes the hull, ring and
 * doors — the ring stays ≥ 1.9 clear and a big building simply covers its door.
 */
export const FOOTPRINT_MAX = 2.1;
/** Smallest ground radius — an idle service is still a building you can click. */
export const FOOTPRINT_MIN = 0.5;

/** Ground radius of a building from the memory its service uses: area ∝ RAM. */
export function footprintRadiusFor(m: MetricSnapshot | undefined): number | undefined {
  if (m?.memoryMb == null) {
    return undefined;
  }
  const r = FOOTPRINT_MAX * Math.sqrt(Math.max(m.memoryMb, 0) / LOT_MB);
  return Math.min(Math.max(r, FOOTPRINT_MIN), FOOTPRINT_MAX);
}
