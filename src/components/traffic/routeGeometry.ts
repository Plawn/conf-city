import { LANE_SLEW } from "../geo/path";
import {
  buildTrajectory,
  createPose,
  type Point3,
  sampleTrajectory,
  segmentAt,
  type Trajectory,
} from "../mobility/trajectory";

export const RIDE_HEIGHT = 0.06;
export const CAR_LENGTH = 0.55;
export const TRUCK_LENGTH = CAR_LENGTH * 1.25;
const LANE_BLEND = 0.6;
/** Arc-length resolution of the lane-offset profile. */
const LANE_STEP = 0.1;

export interface LaneGeom extends Trajectory {
  ring: Uint8Array;
  cap: Float32Array;
}

/** The first lane remains the default geometry for route-level diagnostics. */
export interface RouteGeom extends LaneGeom {
  lanes: [LaneGeom, LaneGeom];
}

export function laneGeometry(g: RouteGeom | null | undefined, lane: number): LaneGeom | null {
  return g?.lanes[lane === 1 ? 1 : 0] ?? null;
}

export function buildRouteGeom(
  points: Point3[],
  lanes?: [number, number][],
  ring?: boolean[],
  loop = false,
): RouteGeom | null {
  const center = buildTrajectory(points, loop);
  if (!center) {
    return null;
  }
  const count = center.dirX.length;
  const normals: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.hypot(center.dirX[i]!, center.dirZ[i]!);
    normals.push(
      length > 1e-6
        ? [-center.dirZ[i]! / length, center.dirX[i]! / length]
        : (normals[i - 1] ?? [1, 0]),
    );
  }
  const miters: [number, number][] = [];
  for (let i = 0; i <= count; i++) {
    const a = normals[i > 0 ? i - 1 : loop ? count - 1 : 0]!;
    const b = normals[i < count ? i : loop ? 0 : count - 1]!;
    const x = a[0] + b[0];
    const z = a[1] + b[1];
    const magnitude = Math.hypot(x, z);
    const scale = magnitude > 1e-8 ? 1 / Math.max(0.5, (x * b[0] + z * b[1]) / magnitude) : 1;
    miters.push(magnitude > 1e-8 ? [(x / magnitude) * scale, (z / magnitude) * scale] : a);
  }
  /**
   * The lane offset as a *continuous* function of arc length.
   *
   * The raw offsets are per centreline segment, so they step: a bridge deck
   * (0.25) meeting a boulevard (0.70), a corner too tight for the outer lane.
   * A step of 0.45 spread over `LANE_BLEND` is a 37° kink in the driven path,
   * whatever averaging follows — and slewing per *segment* cannot help, because
   * the segment carrying the step may be 30 long (the deck) while the change
   * has to happen in the metre before it.
   *
   * So the profile is resampled on a uniform arc-length grid, and made
   * `LANE_SLEW`-Lipschitz there: `f(d) = min_e (raw(e) + LANE_SLEW · |d − e|)`,
   * which two sweeps compute exactly (twice round on a loop). A centred box
   * average then rounds the corners the envelope leaves — centred, not
   * trailing, so the weave straddles the change instead of trailing 0.6 behind
   * it.
   */
  const laneProfile = (offsets: number[]): ((d: number) => number) => {
    const cells = Math.max(2, Math.ceil(center.total / LANE_STEP));
    const h = center.total / cells;
    const n = loop ? cells : cells + 1;
    const wrap = (i: number) => (loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      v[i] = offsets[segmentAt(center, Math.min(i * h, center.total - 1e-9))]!;
    }
    const slack = LANE_SLEW * h;
    for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
      for (let i = 1; i < n; i++) {
        v[i] = Math.min(v[i]!, v[i - 1]! + slack);
      }
      if (loop) {
        v[0] = Math.min(v[0]!, v[n - 1]! + slack);
      }
      for (let i = n - 2; i >= 0; i--) {
        v[i] = Math.min(v[i]!, v[i + 1]! + slack);
      }
      if (loop) {
        v[n - 1] = Math.min(v[n - 1]!, v[0]! + slack);
      }
    }
    const half = Math.max(1, Math.round(LANE_BLEND / 2 / h));
    const smooth = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) {
        sum += v[wrap(i + k)]!;
      }
      smooth[i] = sum / (2 * half + 1);
    }
    return (distance) => {
      const t = loop ? (((distance / h) % n) + n) % n : Math.max(0, Math.min(n - 1, distance / h));
      const i = Math.floor(t);
      const a = smooth[wrap(i)]!;
      const b = smooth[wrap(i + 1)]!;
      return a + (b - a) * (t - i);
    };
  };
  const bake = (lane: number): LaneGeom | null => {
    const offsetAt = laneProfile(
      Array.from(center.source, (source) => lanes?.[source]?.[lane] ?? 0.25),
    );
    const path: Point3[] = [];
    const tags: boolean[] = [];
    const sample = createPose();
    for (let s = 0; s < count; s++) {
      const length = center.cum[s + 1]! - center.cum[s]!;
      const steps = Math.max(1, Math.ceil(length / 0.15));
      for (let k = 0; k <= steps; k++) {
        if (s > 0 && k === 0) {
          continue;
        }
        const u = k / steps;
        const d = center.cum[s]! + length * u;
        sampleTrajectory(center, d, sample);
        const offset = offsetAt(d);
        const a = miters[s]!;
        const b = miters[s + 1]!;
        path.push([
          sample.x + (a[0] + (b[0] - a[0]) * u) * offset,
          sample.y,
          sample.z + (a[1] + (b[1] - a[1]) * u) * offset,
        ]);
        if (path.length > 1) {
          tags.push(ring?.[center.source[s]!] ?? false);
        }
      }
    }
    if (loop) {
      path[path.length - 1] = [...path[0]!];
    }
    const geometry = buildTrajectory(path, loop);
    if (!geometry) {
      return null;
    }
    const cap = new Float32Array(geometry.dirX.length);
    const before = createPose();
    const after = createPose();
    for (let s = 0; s < cap.length; s++) {
      const d = (geometry.cum[s]! + geometry.cum[s + 1]!) / 2;
      sampleTrajectory(geometry, d - 0.3, before);
      sampleTrajectory(geometry, d + 0.3, after);
      const dot = before.fx * after.fx + before.fy * after.fy + before.fz * after.fz;
      cap[s] = Math.max(
        0.45,
        Math.min(1, 1 - (0.5 * Math.acos(Math.max(-1, Math.min(1, dot)))) / 0.6),
      );
    }
    return { ...geometry, cap, ring: Uint8Array.from(geometry.source, (s) => (tags[s] ? 1 : 0)) };
  };
  const first = bake(0);
  const second = lanes?.some(([a, b]) => a !== b) ? bake(1) : first;
  return first && second ? { ...first, lanes: [first, second] } : null;
}
