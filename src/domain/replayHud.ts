import { dateAt, presenceAt, type Timeline } from "./scenario";

/** The replay's heads-up display as a pure function of video time: an export frame matches playback. */

export interface HudCounts {
  cities: number;
  clouds: number;
  nodes: number;
}

/** What stands at `t`: a piece counts once it is halfway up, and until it is halfway down. */
export function hudCounts(tl: Timeline, t: number): HudCounts {
  const presence = presenceAt(tl, t);
  const clouds = new Set(tl.world.cities.filter((c) => c.cloud).map((c) => c.id));
  const out: HudCounts = { cities: 0, clouds: 0, nodes: 0 };
  for (const [id, p] of presence.cities) {
    if (p >= 0.5) {
      out[clouds.has(id) ? "clouds" : "cities"]++;
    }
  }
  for (const p of presence.nodes.values()) {
    if (p >= 0.5) {
      out.nodes++;
    }
  }
  return out;
}

/** A displayed value at `t` and, within `fade` seconds of its last change, the one it replaced. */
export interface Change<T> {
  current: T;
  previous: T | null;
  /** Progress of the change, 0 → 1 (1 when settled). */
  k: number;
}

/** The change instant is found by bisection, so it is exact whatever the frame rate. */
export function changeAt<T>(
  value: (t: number) => T,
  same: (a: T, b: T) => boolean,
  t: number,
  fade: number,
): Change<T> {
  const current = value(t);
  if (fade <= 0 || same(value(t - fade), current)) {
    return { current, previous: null, k: 1 };
  }
  let lo = t - fade;
  let hi = t;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (same(value(mid), current)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { current, previous: value(lo), k: Math.min(1, (t - hi) / fade) };
}

const monthOf = (d: Date) => d.getFullYear() * 12 + d.getMonth();

/** The month on screen, sliding out for the next over `fade` seconds. */
export function monthAt(tl: Timeline, t: number, fade: number): Change<Date> {
  return changeAt(
    (s) => dateAt(tl, s),
    (a, b) => monthOf(a) === monthOf(b),
    t,
    fade,
  );
}

/** One counter, rolling to its new value over `fade` seconds. */
export function countAt(
  tl: Timeline,
  t: number,
  fade: number,
  key: keyof HudCounts,
): Change<number> {
  return changeAt(
    (s) => hudCounts(tl, s)[key],
    (a, b) => a === b,
    t,
    fade,
  );
}
