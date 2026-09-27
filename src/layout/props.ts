import type { PropKind } from "../domain/biome";
import { NODE_STYLE } from "../domain/nodeStyle";
import { fnv1a, mulberry32 } from "../lib/random";
import { pointInPolygon, polygonBounds } from "./geometry";
import type { CityLayout, RoadClass, Vec2 } from "./types";
import { PLOT_RADIUS } from "./utilityPlot";

/** One plant or rock, placed on free land. World coordinates, like everything else here. */
export interface ScatteredProp {
  kind: PropKind;
  at: Vec2;
  /** Turn, radians. */
  yaw: number;
  /** 0.72 .. 1.28 — nothing in nature is the same size twice. */
  scale: number;
}

/** Clear of the shore, so nothing hangs over the beach or floats off the bevel. */
const SHORE_MARGIN = 1.2;
/** Clear of the kerb, on top of the road's own half-width. */
const ROAD_MARGIN = 0.5;
/** Clear of a building's footprint, on top of its own half-width. */
const PLOT_MARGIN = 0.5;
/** How far a prop may wander inside its grid cell, as a share of the cell. */
const JITTER = 0.42;
/** Ceiling per city: a scatter is cheap to compute and expensive to draw. */
const MAX_PROPS = 420;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p[0] - (a[0] + t * vx);
  const dz = p[1] - (a[1] + t * vz);
  return Math.hypot(dx, dz);
}

function distToPolyline(p: Vec2, points: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = distToSegment(p, points[i - 1]!, points[i]!);
    if (d < best) {
      best = d;
    }
  }
  return best;
}

/**
 * Scatter a biome's vegetation over whatever land the city is not using.
 *
 * Pure and seeded on the city id, like every other layout step: the same city
 * grows the same trees in the same places on every reload, and on every client.
 *
 * The method is a jittered grid rather than true Poisson-disc sampling — the
 * grid already guarantees a minimum spacing, and the jitter is what stops it
 * reading as a grid. Candidates are then rejected against the island's own
 * furniture: the shore, the roads (each by its own class width), the roundabout
 * islands, the driveways and the building plots. Nothing here knows how wide a
 * road is drawn, so `clearance` comes in from the renderer, which owns
 * `CLASS_STYLE` — the one place a road's width is decided.
 */
export function scatterProps(
  layout: CityLayout,
  vegetation: { density: number; kinds: readonly PropKind[] },
  clearance: Record<RoadClass, number>,
): ScatteredProp[] {
  const { kinds, density } = vegetation;
  if (kinds.length === 0 || density <= 0) {
    return [];
  }
  const bounds = polygonBounds(layout.outline);
  if (!bounds) {
    return [];
  }

  // `density` is props per 100 world units² of free land: one per cell of that
  // area, then the rejections below take the occupied land back out.
  const cell = Math.sqrt(100 / density);
  const rand = mulberry32(fnv1a(`props:${layout.cityId}`));

  // Buildings and roundabouts are points with a radius; roads are polylines with
  // a width. Flattened once, outside the candidate loop.
  const circles: Array<{ at: Vec2; r: number }> = [];
  for (const node of layout.nodes) {
    const s = NODE_STYLE[node.type].scale;
    circles.push({ at: [node.position[0], node.position[2]], r: s * 0.75 + PLOT_MARGIN });
  }
  for (const r of layout.roads.roundabouts) {
    circles.push({ at: r.center, r: r.radius + ROAD_MARGIN });
  }
  // The utility district is reserved land, not free land: nothing grows on it.
  for (const slot of layout.utilityPlot?.slots ?? []) {
    circles.push({ at: slot.center, r: PLOT_RADIUS });
  }
  const lines: Array<{ points: Vec2[]; r: number }> = [];
  for (const seg of layout.roads.segments) {
    lines.push({ points: seg.points, r: clearance[seg.klass] + ROAD_MARGIN });
  }
  for (const d of layout.roads.driveways) {
    lines.push({ points: [d.mouth, d.door], r: clearance[d.klass] + ROAD_MARGIN });
  }
  if (layout.roads.ring.length > 1) {
    lines.push({
      points: [...layout.roads.ring, layout.roads.ring[0]!],
      r: clearance.avenue + ROAD_MARGIN,
    });
  }

  const props: ScatteredProp[] = [];
  const minX = bounds.cx - bounds.width / 2;
  const maxX = bounds.cx + bounds.width / 2;
  const minZ = bounds.cz - bounds.height / 2;
  const maxZ = bounds.cz + bounds.height / 2;
  for (let z = minZ; z <= maxZ && props.length < MAX_PROPS; z += cell) {
    for (let x = minX; x <= maxX && props.length < MAX_PROPS; x += cell) {
      const at: Vec2 = [
        x + cell * (0.5 + (rand() - 0.5) * 2 * JITTER),
        z + cell * (0.5 + (rand() - 0.5) * 2 * JITTER),
      ];
      if (!pointInPolygon(at, layout.outline)) {
        continue;
      }
      if (distToPolyline(at, [...layout.outline, layout.outline[0]!]) < SHORE_MARGIN) {
        continue;
      }
      let free = true;
      for (const c of circles) {
        if (Math.hypot(at[0] - c.at[0], at[1] - c.at[1]) < c.r) {
          free = false;
          break;
        }
      }
      if (free) {
        for (const l of lines) {
          if (distToPolyline(at, l.points) < l.r) {
            free = false;
            break;
          }
        }
      }
      if (!free) {
        continue;
      }
      props.push({
        kind: kinds[Math.floor(rand() * kinds.length) % kinds.length]!,
        at,
        yaw: rand() * Math.PI * 2,
        scale: 0.72 + rand() * 0.56,
      });
    }
  }
  return props;
}
