import type { Vec2 } from "../../layout/types";
import { STATIONS, stationDistance } from "./metro";
import { TRACK_HEIGHT } from "./metroTrack";
import {
  buildTrajectory,
  createPose,
  type Point3,
  type Pose,
  sampleTrajectory,
  type Trajectory,
} from "./trajectory";

/**
 * A station's *pedestrian* geometry, described once and used twice: the meshes
 * are built from it, and passengers walk it. Everything is measured inward,
 * toward `city.center` — outside the ring road there are barely two units of
 * land before the shore, so a station that grew outward would stand in the sea.
 */

/** Platform, beside the viaduct. */
export const PLATFORM_OFFSET = 1.2;
/** Head of the stairs, at the inner edge of the platform. */
export const STAIR_TOP_OFFSET = 1.55;
/** Foot of the stairs, on the ground. */
export const STAIR_FOOT_OFFSET = 3.15;
/** Where walkers appear and vanish, on the pavement. */
export const STREET_OFFSET = 4.55;
export const PLATFORM_TOP = TRACK_HEIGHT + 0.075;
export const STREET_Y = 0.12;
/** Usable length of platform: waiting passengers spread over it. */
export const PLATFORM_SPREAD = 1.2;
/** Within this of the far end of `walk`, a walker is on the platform. */
const PLATFORM_ZONE = 0.2;

export interface StationAccess {
  index: number;
  /** Arc length of the station on the metro loop. */
  distance: number;
  /** Unit vector from the station toward the city centre. */
  inX: number;
  inZ: number;
  /** Unit horizontal tangent of the track, the direction of travel. */
  alongX: number;
  alongZ: number;
  /** The point on the viaduct the rames stop at. */
  track: Point3;
  street: Point3;
  stairFoot: Point3;
  stairTop: Point3;
  door: Point3;
  /** Open path street → stairFoot → stairTop → door; `total` is the walk length. */
  walk: Trajectory;
}

function at(x: number, z: number, inX: number, inZ: number, offset: number, y: number): Point3 {
  return [x + inX * offset, y, z + inZ * offset];
}

export function buildStationAccess(
  route: Trajectory,
  center: Vec2,
  index: number,
): StationAccess | null {
  const pose = sampleTrajectory(route, stationDistance(route, index), createPose());
  const dx = center[0] - pose.x;
  const dz = center[1] - pose.z;
  const radial = Math.hypot(dx, dz);
  const tangent = Math.hypot(pose.fx, pose.fz);
  if (radial < 1e-3 || tangent < 1e-6) {
    return null;
  }
  const inX = dx / radial;
  const inZ = dz / radial;
  const street = at(pose.x, pose.z, inX, inZ, STREET_OFFSET, STREET_Y);
  const stairFoot = at(pose.x, pose.z, inX, inZ, STAIR_FOOT_OFFSET, STREET_Y);
  const stairTop = at(pose.x, pose.z, inX, inZ, STAIR_TOP_OFFSET, PLATFORM_TOP);
  const door = at(pose.x, pose.z, inX, inZ, PLATFORM_OFFSET, PLATFORM_TOP);
  const walk = buildTrajectory([street, stairFoot, stairTop, door], false);
  if (!walk) {
    return null;
  }
  return {
    index,
    distance: stationDistance(route, index),
    inX,
    inZ,
    alongX: pose.fx / tangent,
    alongZ: pose.fz / tangent,
    track: [pose.x, TRACK_HEIGHT, pose.z],
    street,
    stairFoot,
    stairTop,
    door,
    walk,
  };
}

export function buildStationAccesses(route: Trajectory, center: Vec2): StationAccess[] {
  const accesses: StationAccess[] = [];
  for (let index = 0; index < STATIONS; index++) {
    const access = buildStationAccess(route, center, index);
    if (access) {
      accesses.push(access);
    }
  }
  return accesses.length === STATIONS ? accesses : [];
}

/**
 * Place a walker `distance` along the access path, `lateral` aside. Waiting
 * passengers face the track; everyone else faces the way they are walking.
 */
export function placeOnAccess(
  access: StationAccess,
  distance: number,
  lateral: number,
  out: Pose,
): void {
  const walk = access.walk;
  const d = Math.min(walk.total, Math.max(0, distance));
  sampleTrajectory(walk, d, out);
  const horizontal = Math.hypot(out.fx, out.fz);
  if (horizontal > 1e-6) {
    out.x += (out.fz / horizontal) * lateral;
    out.z += (-out.fx / horizontal) * lateral;
  }
}

/** Heading of a walker at `distance`, in radians around Y. */
export function headingOnAccess(access: StationAccess, distance: number, pose: Pose): number {
  return distance >= access.walk.total - PLATFORM_ZONE
    ? Math.atan2(-access.inX, -access.inZ)
    : Math.atan2(pose.fx, pose.fz);
}
