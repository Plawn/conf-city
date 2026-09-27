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

/** Cores at which a service's chimney smokes at full rate. */
export const SERVICE_SMOKE_REF_CORES = 2;

/**
 * How hard a service's building smokes, 0..1, from the cores it uses — absolute,
 * so two cities compare. Log-eased: a tenth of a core already shows (≈ 0.3),
 * an idle service only wisps. `undefined` when the CPU is not measured.
 */
export function serviceSmoke(cpuPct: number | undefined): number | undefined {
  if (cpuPct == null) {
    return undefined;
  }
  const cores = Math.max(cpuPct, 0) / 100;
  return clamp01(Math.log1p(cores * 20) / Math.log1p(SERVICE_SMOKE_REF_CORES * 20));
}

/** Puffs a chimney at full smoke gets. */
export const PUFFS_PER_CHIMNEY = 14;
/** Below this smoke (≈ 2 % of a core) a building stays clear: idle is not a wisp. */
export const MIN_SMOKE = 0.08;

/**
 * Puffs per building: its own smoke times `perChimney` (absolute, so an idle
 * city stays clear), at least one from `MIN_SMOKE` up. Over
 * the city's budget, the demand is scaled down by largest remainder — the
 * hottest keep their single puff first, so every hot spot stays findable.
 */
export function allotPuffs(
  rates: readonly number[],
  budget: number,
  perChimney = PUFFS_PER_CHIMNEY,
): number[] {
  const demand = rates.map((r) => (r >= MIN_SMOKE ? Math.max(1, Math.round(r * perChimney)) : 0));
  let left = Math.max(0, Math.floor(budget));
  const wanted = demand.reduce((a, b) => a + b, 0);
  if (wanted <= left) {
    return demand;
  }
  const out = rates.map(() => 0);
  const lit = demand.flatMap((d, i) => (d > 0 ? [i] : []));
  lit.sort((a, b) => rates[b]! - rates[a]! || a - b);
  for (const i of lit) {
    if (left === 0) {
      return out;
    }
    out[i] = 1;
    left--;
  }
  // Share what is left over the demand beyond the first puff.
  const extra = lit.map((i) => demand[i]! - 1);
  const total = extra.reduce((a, b) => a + b, 0);
  if (left === 0 || total === 0) {
    return out;
  }
  const pool = left;
  const shares = lit.map((i, k) => ({ i, exact: (extra[k]! / total) * pool }));
  for (const { i, exact } of shares) {
    out[i]! += Math.floor(exact);
    left -= Math.floor(exact);
  }
  shares.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.i - b.i);
  for (let k = 0; k < left; k++) {
    out[shares[k]!.i]! += 1;
  }
  return out;
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
