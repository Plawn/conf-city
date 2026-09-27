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
