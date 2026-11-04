import type { ResolvedLink } from "../domain/types";
import { clamp01 } from "../lib/math";
import { pairKey } from "./bridges";
import { CLOUD_ALTITUDE } from "./cloud";
import { type CityLayout, linkKey, type Vec2 } from "./types";

/** Height of the cable where it leaves the shore mast. */
export const MAST_HEIGHT = 4;
/** Height of the cable above the cloud deck, where it enters the top station. */
export const TOP_STATION_HEIGHT = 1;
/** Height of the cable where it enters the top station, above the sea. */
export const TOP_Y = CLOUD_ALTITUDE + TOP_STATION_HEIGHT;
/** How far into the sea the mast stands from the shore: clear of the ring road. */
const MAST_OFFSHORE = 0.9;
/** How far onto the deck the top station stands from the cloud's rim. */
const TOP_INSET = 1.8;

/**
 * One cable car per pair (island, cloud service), the way bridges merge every
 * link between two islands: a mast just off the island's shore, a station on
 * the cloud's deck, and the links it carries (their traffic sets the cabins).
 */
export interface Cableway {
  /** `"cityA|cityB"`, cities in lexical order, like a bridge. */
  key: string;
  ground: string;
  cloud: string;
  /** Mast foot, world coords, sea level. */
  base: Vec2;
  /** Top station, world coords, on the cloud deck. */
  top: Vec2;
  links: ResolvedLink[];
}

function nearest(outline: Vec2[], to: Vec2): Vec2 | undefined {
  let best: Vec2 | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of outline) {
    const d = Math.hypot(p[0] - to[0], p[1] - to[1]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** `p` moved by `d` along the direction from `from` to `p` (negative: back toward `from`). */
function push(p: Vec2, from: Vec2, d: number): Vec2 {
  const dx = p[0] - from[0];
  const dz = p[1] - from[1];
  const len = Math.hypot(dx, dz) || 1;
  return [p[0] + (dx / len) * d, p[1] + (dz / len) * d];
}

/** Cable cars for every inter-city link with exactly one cloud end; cloud-to-cloud links stay invisible. */
export function buildCableways(cities: Map<string, CityLayout>, links: ResolvedLink[]): Cableway[] {
  const byPair = new Map<string, ResolvedLink[]>();
  const seen = new Set<string>();
  for (const link of links) {
    const from = cities.get(link.fromCityId);
    const to = cities.get(link.toCityId);
    if (!link.interCity || !from || !to || !!from.cloud === !!to.cloud) {
      continue;
    }
    const key = linkKey(link);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const pair = pairKey(link);
    byPair.set(pair, [...(byPair.get(pair) ?? []), link]);
  }

  const cableways: Cableway[] = [];
  for (const pair of [...byPair.keys()].sort()) {
    const [a, b] = pair.split("|") as [string, string];
    const [ground, cloud] = cities.get(a)!.cloud
      ? [cities.get(b)!, cities.get(a)!]
      : [cities.get(a)!, cities.get(b)!];
    const shore = nearest(ground.outline, cloud.center);
    if (!shore) {
      continue;
    }
    const base = push(shore, ground.center, MAST_OFFSHORE);
    const rim = nearest(cloud.outline, base) ?? cloud.center;
    const top = push(rim, cloud.center, -TOP_INSET);
    const carried = byPair.get(pair)!.sort((x, y) => linkKey(x).localeCompare(linkKey(y)));
    cableways.push({
      key: pair,
      ground: ground.cityId,
      cloud: cloud.cityId,
      base,
      top,
      links: carried,
    });
  }
  return cableways;
}

/** A cable sampled from the mast to the top station: positions and arc length. */
export interface CableSpan {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Cumulative arc length at each sample. */
  s: Float32Array;
  length: number;
}

/**
 * The cable between `base` and `top`, shifted sideways by `lateral` (two cables,
 * one per direction), sagging like a loaded rope: a parabola under the chord.
 */
export function cableSpan(way: Cableway, lateral = 0, segments = 24): CableSpan {
  const [bx, bz] = way.base;
  const [tx, tz] = way.top;
  const dx = tx - bx;
  const dz = tz - bz;
  const horizontal = Math.hypot(dx, dz) || 1;
  // Right-hand side of the climb, the perpendicular `polyline.ts` calls "right".
  const ox = (dz / horizontal) * lateral;
  const oz = (-dx / horizontal) * lateral;
  const y0 = MAST_HEIGHT;
  const y1 = TOP_Y;
  const sag = 0.05 * Math.hypot(horizontal, y1 - y0);
  const n = segments + 1;
  const span: CableSpan = {
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    s: new Float32Array(n),
    length: 0,
  };
  for (let i = 0; i < n; i++) {
    const t = i / segments;
    span.x[i] = bx + dx * t + ox;
    span.z[i] = bz + dz * t + oz;
    span.y[i] = y0 + (y1 - y0) * t - 4 * sag * t * (1 - t);
    if (i > 0) {
      span.length += Math.hypot(
        span.x[i]! - span.x[i - 1]!,
        span.y[i]! - span.y[i - 1]!,
        span.z[i]! - span.z[i - 1]!,
      );
    }
    span.s[i] = span.length;
  }
  return span;
}

/** Point on the cable at fraction `u` ∈ [0, 1] of its length, written into `out`. */
export function cablePoint(span: CableSpan, u: number, out: [number, number, number]) {
  const target = clamp01(u) * span.length;
  let i = 1;
  while (i < span.s.length - 1 && span.s[i]! < target) {
    i++;
  }
  const s0 = span.s[i - 1]!;
  const s1 = span.s[i]!;
  const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
  out[0] = span.x[i - 1]! + (span.x[i]! - span.x[i - 1]!) * f;
  out[1] = span.y[i - 1]! + (span.y[i]! - span.y[i - 1]!) * f;
  out[2] = span.z[i - 1]! + (span.z[i]! - span.z[i - 1]!) * f;
  return out;
}
