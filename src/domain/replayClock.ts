import { BLAST_SEC } from "./blast";

/**
 * The replay's date → video-second map: piecewise linear, slower where events crowd
 * (`docs/replay.md`, slow motion). Pure, so a scrubbed frame and a rendered one agree.
 */
export interface Clock {
  /** Knots: date (ms) → video second. A date repeats when its events play as a cascade. */
  ms: number[];
  sec: number[];
  /** Video seconds per ms outside the knots. */
  rate: number;
}

/** Everything that happens on one date, as endpoint keys in scenario order. */
export interface Moment {
  cities: string[];
  nodes: string[];
  /** `ends`: endpoint keys of the nodes it joins; a link rises with the last of them. */
  links: { key: string; ends: string[] }[];
  removals: string[];
  /** A city or node leaves: room for the blast. */
  blast: boolean;
}

export interface ClockOptions {
  /** Least video seconds between two steps that should be seen apart. */
  gap: number;
  /** Seconds between two buildings rising on the same date. */
  stagger: number;
}

export function emptyMoment(): Moment {
  return { cities: [], nodes: [], links: [], removals: [], blast: false };
}

/**
 * Same-date events as a cascade: islands, then each building in turn (its roads with it),
 * then demolitions. Offsets in seconds from the date's first step.
 */
export function planMoment(m: Moment, { gap, stagger }: ClockOptions) {
  const offsets = new Map<string, number>();
  let t = 0;
  let prev: "city" | "node" | null = null;
  const step = (kind: "city" | "node" | "remove") => {
    if (prev) {
      t += prev === "city" || kind === "remove" ? gap : stagger;
    }
    prev = kind === "remove" ? null : kind;
  };
  if (m.cities.length > 0) {
    step("city");
    for (const k of m.cities) {
      offsets.set(k, t);
    }
  }
  for (const k of m.nodes) {
    step("node");
    offsets.set(k, t);
  }
  const lone: string[] = [];
  for (const l of m.links) {
    const ends = l.ends.map((e) => offsets.get(e)).filter((o) => o !== undefined);
    if (ends.length > 0) {
      offsets.set(l.key, Math.max(...ends));
    } else {
      lone.push(l.key);
    }
  }
  if (lone.length > 0) {
    step("node");
    for (const k of lone) {
      offsets.set(k, t);
    }
  }
  if (m.removals.length > 0) {
    step("remove");
    for (const k of m.removals) {
      offsets.set(k, t);
    }
  }
  const after = gap <= 0 ? 0 : m.blast ? Math.max(gap, BLAST_SEC) : gap;
  return { offsets, length: t, after };
}

/**
 * Distinct event dates sit at least a cascade plus `gap` apart (a blast after a demolition);
 * quiet stretches keep the base pace. Returns the clock and each endpoint's video second.
 */
export function buildClock(
  period: { start: number; end: number; intro: number; durationSec: number },
  moments: Map<number, Moment>,
  opts: ClockOptions,
) {
  const { start, end, intro, durationSec } = period;
  const rate = durationSec / (end - start);
  const dates = [...new Set([start, end, ...moments.keys()])]
    .filter((d) => d >= start && d <= end)
    .sort((a, b) => a - b);
  const clock: Clock = { ms: [], sec: [], rate };
  const offsets = new Map<string, number>();
  const firstStep = new Map<number, number>();
  let prev: { date: number; sec: number; busy: number } | null = null;
  for (const date of dates) {
    const plan = moments.has(date) ? planMoment(moments.get(date)!, opts) : null;
    const sec: number = prev ? prev.sec + Math.max((date - prev.date) * rate, prev.busy) : intro;
    firstStep.set(date, sec);
    clock.ms.push(date);
    clock.sec.push(sec);
    if (plan && plan.length > 0) {
      // The date on screen holds while the cascade plays.
      clock.ms.push(date);
      clock.sec.push(sec + plan.length);
    }
    for (const [k, o] of plan?.offsets ?? []) {
      offsets.set(k, o);
    }
    prev = { date, sec, busy: plan ? plan.length + plan.after : 0 };
  }
  /** Video second of endpoint `key`, dated `ms`. */
  const at = (ms: number, key: string) =>
    (firstStep.get(ms) ?? clockSec(clock, ms)) + (offsets.get(key) ?? 0);
  return { clock, at };
}

/** Video second of date `ms` (the end of its cascade, if any). */
export function clockSec(c: Clock, ms: number): number {
  return lerpKnots(c.ms, c.sec, ms, c.rate);
}

/** Date (ms) shown at video second `sec`. */
export function clockMs(c: Clock, sec: number): number {
  return lerpKnots(c.sec, c.ms, sec, 1 / c.rate);
}

function lerpKnots(xs: number[], ys: number[], x: number, slope: number): number {
  const n = xs.length;
  if (x <= xs[0]!) {
    return ys[0]! + (x - xs[0]!) * slope;
  }
  if (x >= xs[n - 1]!) {
    return ys[n - 1]! + (x - xs[n - 1]!) * slope;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const x0 = xs[lo]!;
  const x1 = xs[hi]!;
  return x1 === x0 ? ys[hi]! : ys[lo]! + ((x - x0) / (x1 - x0)) * (ys[hi]! - ys[lo]!);
}
