import { clamp01 } from "../../lib/math";

/**
 * The three machine figures, turned into things a district can be built out of.
 *
 * Each one answers `undefined` when the figure is missing rather than 0: an
 * unmeasured machine gets an installation under construction, never a chimney
 * that reads as an idle CPU. `cityUsage()` is the only source — nothing here
 * asks the provider for anything new.
 */

/**
 * How hard the power station smokes, 0..1 — `undefined` when the CPU is not
 * measured. Mildly eased so the low end is still visible: a machine at 20 %
 * must not look like one at rest, which a linear ramp on a puff count does.
 */
export function smokeRate(cpuPct: number | undefined): number | undefined {
  if (cpuPct == null) {
    return undefined;
  }
  return clamp01(cpuPct / 100) ** 0.7;
}

/** Seconds the plume takes to build up, and to die away — a peak lingers. */
export const PLUME_RISE_S = 4;
export const PLUME_FALL_S = 40;

/**
 * The plume's smoothed strength after `dtSec`, chasing `target` (a `smokeRate`):
 * fast on the way up so a load shows at once, slow on the way down so a spike is
 * still hanging over the island a minute later.
 */
export function plumeLevel(prev: number, target: number, dtSec: number): number {
  const tau = target > prev ? PLUME_RISE_S : PLUME_FALL_S;
  return target + (prev - target) * Math.exp(-Math.max(0, dtSec) / tau);
}

/**
 * The saturated regime, 0..1: nothing under 75 % CPU, full at 95 %. What turns
 * a working plant into one that is visibly struggling — taller, darker plume and
 * obstruction lights. `undefined` when the CPU is not measured.
 */
export function smokeSurge(cpuPct: number | undefined): number | undefined {
  if (cpuPct == null) {
    return undefined;
  }
  const x = clamp01((cpuPct - 75) / 20);
  return x * x * (3 - 2 * x);
}

/** How full the water tower stands, 0..1 — `undefined` when memory is unknown. */
export function tankLevel(memPct: number | undefined): number | undefined {
  return memPct == null ? undefined : clamp01(memPct / 100);
}

/** What a container quay is stacked with. */
export interface QuayLoad {
  /** Boxes on the quay, `0..capacity`. */
  count: number;
  /** A full disk: the quay is stacked past its rows and the last pile leans. */
  overflow: boolean;
}

/**
 * Boxes for a disk figure — `undefined` when nothing is mounted (no service-sum
 * fallback exists for a filesystem). An empty quay is a fresh disk, a full one
 * is a full disk, and `overflow` past 95 % is what makes "nearly full" and
 * "full" different at a glance from across the room.
 */
export function containerCount(
  diskPct: number | undefined,
  capacity: number,
): QuayLoad | undefined {
  if (diskPct == null) {
    return undefined;
  }
  const pct = clamp01(diskPct / 100);
  return { count: Math.round(pct * capacity), overflow: pct >= 0.95 };
}
