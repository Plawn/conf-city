import { TERRAIN } from "../../domain/nodeStyle";
import type { RoadClass, Roundabout } from "../../layout/types";

/**
 * How the renderer draws each road class. The layout only decides *what* a run
 * is — how many routes share it — and this table turns that into a width, a
 * shade and a lane count, so the whole hierarchy can be retuned in one place.
 * `lanes` is per direction: a boulevard carries two each way.
 */
export const CLASS_STYLE: Record<
  RoadClass,
  { width: number; color: string; lanes: number; edgeLines: boolean; lit: boolean }
> = {
  street: {
    width: TERRAIN.roadWidth,
    color: TERRAIN.roadColor,
    lanes: 1,
    edgeLines: false,
    lit: false,
  },
  avenue: {
    width: TERRAIN.roadWidthAvenue,
    color: TERRAIN.roadColorAvenue,
    lanes: 1,
    edgeLines: true,
    lit: true,
  },
  boulevard: {
    width: TERRAIN.roadWidthBoulevard,
    color: TERRAIN.roadColorBoulevard,
    lanes: 2,
    edgeLines: true,
    lit: true,
  },
};

/** Width of the raised pavement along every road, outside the asphalt. */
export const PAVEMENT = 0.35;
/** Radius of the kerb at a block corner. */
export const FILLET = 0.6;

/** Smallest planted island left at the centre of a roundabout, whatever the class. */
export const MIN_ISLAND_RADIUS = 0.55;
export const ISLAND_HEIGHT = 0.18;

/**
 * Inner and outer radius of the tarmac ring of a roundabout. A wider class eats
 * outwards, never into the island: below `MIN_ISLAND_RADIUS` the centre stops
 * reading as a terre-plein and turns back into a hole in the asphalt.
 */
export function ringRadii(r: Roundabout): { inner: number; outer: number } {
  const half = CLASS_STYLE[r.klass].width / 2;
  const inner = Math.max(r.radius - half, MIN_ISLAND_RADIUS);
  return { inner, outer: inner + 2 * half };
}

/**
 * Where a vehicle rides on one step of a path, as offsets to the driver's
 * right: lane 0 and lane 1 (equal where the road has a single lane per way).
 */
export type Lanes = [number, number];

/**
 * Lane offsets of a road class. One lane per way sits in the middle of its
 * half; a boulevard's two share the half between the double centre line and
 * the edge line, so lane 1 rides between the lane dashes and the edge.
 */
export function laneOffsets(klass: RoadClass): Lanes {
  const half = CLASS_STYLE[klass].width / 2;
  return CLASS_STYLE[klass].lanes >= 2 ? [half * 0.28, half * 0.7] : [half / 2, half / 2];
}

/** The widest a vehicle of any lane sits from the centreline of `klass`. */
export function maxLaneOffset(klass: RoadClass): number {
  const [a, b] = laneOffsets(klass);
  return Math.max(a, b);
}
