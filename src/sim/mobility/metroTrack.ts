import { MAX_TURN } from "../../geo/path";
import { closedSeam, roundCorners } from "../../geo/polyline";
import type { Vec2 } from "../../layout/types";
import type { Point3 } from "./trajectory";
import { buildTrajectory, type Trajectory } from "./trajectory";

/**
 * The metro's own viaduct, built straight from the ring road's polygon.
 *
 * The metro used to ride `makeDriver().loop()` — the *drivable* ring, which
 * goes round every bridgehead roundabout the ring passes through. On the road
 * that is correct: a car has to circle the island. Nine metres up it is not: the
 * viaduct made a full extra turn around each roundabout, 998° of total rotation
 * on `london-1` instead of 360°, and the train appeared to loop the loop in
 * mid-air. Then a closed `CatmullRomCurve3` was fitted through the result,
 * which pulled the track off the ring vertices and added its own bulges.
 *
 * A viaduct answers to none of that. It takes the ring polygon itself, reopened
 * at the *middle* of an edge so the closure is collinear rather than a corner
 * (`closedSeam`), and rounds every vertex on a radius a train can take. No
 * roundabouts, no spline, no Three.js — the whole track is testable.
 */

/** Height of the deck above the ground; the trains ride a little above it. */
export const TRACK_HEIGHT = 2.2;
/**
 * Turning radius of the rail. Far wider than the road's `BEND_RADIUS` (1.2):
 * a train on a hairpin reads as wrong even when the geometry is smooth, and the
 * viaduct has nothing to avoid, so it can cut every corner generously.
 */
export const RAIL_RADIUS = 3;
/** Chord bound of the rounded corners; `MAX_TURN` is what binds on tight ones. */
const RAIL_CHORD = 0.3;

/** The viaduct's centreline as a closed 3D path at `height`. */
export function metroTrackPoints(ring: Vec2[], height = TRACK_HEIGHT): Point3[] {
  if (ring.length < 3) {
    return [];
  }
  const seam = closedSeam(ring, 0);
  const rounded = roundCorners(seam, RAIL_RADIUS, RAIL_CHORD, () => true, MAX_TURN);
  return rounded.map(([x, z]): Point3 => [x, height, z]);
}

/** The viaduct as a closed trajectory, or `null` for a degenerate ring. */
export function buildMetroTrack(ring: Vec2[], height = TRACK_HEIGHT): Trajectory | null {
  const points = metroTrackPoints(ring, height);
  return points.length > 2 ? buildTrajectory(points, true) : null;
}
