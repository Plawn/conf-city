import type { PositionedNode } from "../domain/types";
import { fnv1a, mulberry32 } from "../lib/random";
import { centroid, pointInPolygon, polygonBounds, roundedOffset } from "./geometry";
import { footprintHull, radiusAround } from "./outline";
import type { Vec2 } from "./types";

/** Height of a cloud service's platform above the sea: high enough to read as sky, low enough to frame. */
export const CLOUD_ALTITUDE = 10;

/** Deck height of a laid-out city: sea level, or a cloud service's platform. */
export function cityAltitude(city: { cloud?: boolean } | undefined): number {
  return city?.cloud ? CLOUD_ALTITUDE : 0;
}

/** Deck margin around the buildings: a cloud carries no ring road, so it hugs what it holds. */
const CLOUD_PADDING = 2.2;

/** Least reach from a cloud's centre to its rim, so a one-service cloud still reads in a wide shot. */
const CLOUD_MIN_RADIUS = 6;

/** A cloud service's deck: its buildings' hull, padded (local coordinates, like `islandShore`). */
export function cloudOutline(nodes: PositionedNode[]): Vec2[] {
  if (nodes.length === 0) {
    return roundedOffset([[0, 0]], CLOUD_MIN_RADIUS);
  }
  const hull = footprintHull(nodes);
  const reach = radiusAround(centroid(hull), hull);
  return roundedOffset(hull, Math.max(CLOUD_PADDING, CLOUD_MIN_RADIUS - reach));
}

/** One cotton ball of a cloud's underside, in world coordinates relative to the platform (y = 0). */
export interface CloudPuff {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Rings under the rim, each pulled toward the centre: the cloud tapers into a soft keel. */
const LAYERS = [
  { shrink: 0.06, y: 0.05, r: 0.75, step: 0.85, out: 0 },
  { shrink: 0, y: -0.35, r: 1.1, step: 1.1, out: 0.35 },
  { shrink: 0.28, y: -1.2, r: 1.25, step: 1.5, out: 0 },
  { shrink: 0.55, y: -2.0, r: 1.15, step: 1.7, out: 0 },
  { shrink: 0.8, y: -2.6, r: 0.95, step: 1.6, out: 0 },
];

/** Spacing of the low mounds scattered over the deck, and the room left around each building. */
const MOUND_STEP = 1.5;
const CLEARANCE = 1.3;

/** The puffs billowing over a floating island's edge and hiding its underside, seeded by its id. */
export function cloudPuffs(
  cityId: string,
  outline: Vec2[],
  center: Vec2,
  clear: Vec2[] = [],
): CloudPuff[] {
  if (outline.length < 3) {
    return [];
  }
  const rand = mulberry32(fnv1a(`cloud:${cityId}`));
  const out: CloudPuff[] = [];
  for (const layer of LAYERS) {
    const ring = outline.map(
      ([x, z]) =>
        [
          center[0] + (x - center[0]) * (1 - layer.shrink),
          center[1] + (z - center[1]) * (1 - layer.shrink),
        ] as Vec2,
    );
    for (const [x, z] of pointsEvery(ring, layer.step)) {
      const dx = x - center[0];
      const dz = z - center[1];
      const len = Math.hypot(dx, dz) || 1;
      const push = layer.out + (rand() - 0.5) * 0.3;
      out.push({
        x: x + (dx / len) * push,
        y: layer.y + (rand() - 0.5) * 0.35,
        z: z + (dz / len) * push,
        r: layer.r * (0.8 + rand() * 0.45),
      });
    }
  }
  out.push({ x: center[0], y: -2.9, z: center[1], r: 1.3 });
  // Low mounds over the deck, clear of the buildings, so the top reads as cotton, not a slab.
  const inner = outline.map(
    ([x, z]) => [center[0] + (x - center[0]) * 0.82, center[1] + (z - center[1]) * 0.82] as Vec2,
  );
  const box = polygonBounds(inner)!;
  const [x0, x1] = [box.cx - box.width / 2, box.cx + box.width / 2];
  const [z0, z1] = [box.cz - box.height / 2, box.cz + box.height / 2];
  for (let x = x0; x <= x1; x += MOUND_STEP) {
    for (let z = z0; z <= z1; z += MOUND_STEP) {
      const p: Vec2 = [x + (rand() - 0.5) * 0.8, z + (rand() - 0.5) * 0.8];
      if (
        !pointInPolygon(p, inner) ||
        clear.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < CLEARANCE)
      ) {
        continue;
      }
      out.push({ x: p[0], y: -0.25, z: p[1], r: 0.5 + rand() * 0.35 });
    }
  }
  return out;
}

/** Points every `step` of arc along a closed polygon, from its first vertex (corners not kept). */
function pointsEvery(poly: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = carry;
    while (t < len) {
      const u = t / len;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      t += step;
    }
    carry = t - len;
  }
  return out;
}
