import type { Roundabout } from "../../layout/types";
import { createPose, samplePose, sampleTrajectory } from "../mobility/trajectory";
import type { trafficBudgets } from "./budget";
import type { Junctions } from "./junctions";
import { CAR_LENGTH, type LaneGeom, RIDE_HEIGHT, type RouteGeom } from "./routeGeometry";

/**
 * One drivable path: a polyline already elevated by the caller (road y, or the
 * arch of a bridge deck, see `geo/drivable.ts`), where its lanes are, and what
 * feeds it — the throughput of a node, the ambient rate of the scene, or a
 * fixed trickle.
 */
export interface TrafficRoute {
  junctions?: Roundabout[];
  points: [number, number, number][];
  key?: string;
  zone?: string;
  cityId?: string;
  targetCityId?: string;
  bridgeKey?: string;
  ambientCityId?: string;
  /**
   * Per segment, the offsets to the driver's right of lane 0 and lane 1 (equal
   * on a single-lane road). Absent: `DEFAULT_LANE` everywhere.
   */
  lanes?: [number, number][];
  /** Per segment: the step circulates on a roundabout, and has priority over entering traffic. */
  ring?: boolean[];
  /** Node whose throughput sets the spawn rate; absent → the scene's `ambientRate`. */
  sourceAddr?: string;
  /** Multiplier on either of the above (inferred links get half the traffic). */
  rateScale: number;
  /** Fixed spawn rate in vehicles per second, ignoring `sourceAddr` and `ambientRate`. */
  rate?: number;
  /**
   * A closed path: vehicles spawn anywhere on it and wrap round instead of
   * popping at the end — the ring road's ambient traffic.
   */
  loop?: boolean;
}

/** Struct-of-arrays pool, compacted by swap-remove — index order is meaningless. */
export interface Pool {
  id: Uint32Array;
  age: Float32Array;
  travelled: Float32Array;
  tripLength: Float32Array;
  stuck: Float32Array;
  retire: Float32Array;
  opacity: Float32Array;
  route: Int32Array;
  dist: Float32Array;
  /** Cruise speed. */
  speed: Float32Array;
  /** Current speed. */
  vel: Float32Array;
  yaw: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  length: Float32Array;
  seg: Int32Array;
  tint: Uint8Array;
  /** 0 or 1: which lane the vehicle keeps where the road offers two. */
  lane: Uint8Array;
  /** Seconds spent held at a standstill. */
  stall: Float32Array;
  /** Seconds of priority token left (patience). */
  token: Float32Array;
  /** Seconds left of driving on regardless (stall release). */
  free: Float32Array;
  /** World position and horizontal heading at the end of the last frame. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  hx: Float32Array;
  hz: Float32Array;
  count: number;
}

export interface Sim {
  junctions: Junctions;
  budgets: ReturnType<typeof trafficBudgets>;
  zones: string[];
  enabled: Uint8Array;
  zoneCount: Map<string, number>;
  smoothRate: Float32Array;
  nextId: number;
  recoveryCooldown: number;
  totals: { spawned: number; completed: number; retired: number; rejected: number };
  ppy: Float32Array;
  fid: Uint32Array;
  geoms: (RouteGeom | null)[];
  loops: Uint8Array;
  /** Spawn accumulators, rates (vehicles / s) and truck share, per route. */
  acc: Float32Array;
  rate: Float32Array;
  truckProb: Float32Array;
  cars: Pool;
  trucks: Pool;
  maxCars: number;
  maxTrucks: number;
  random: () => number;
  /**
   * Per-frame scratch, indexed by frame slot (cars first, then trucks) × `SLOTS`
   * probes: probe positions and path directions, plus the hash chaining them.
   */
  ppx: Float32Array;
  ppz: Float32Array;
  pdx: Float32Array;
  pdz: Float32Array;
  pok: Uint8Array;
  /** Per probe: the probe lies on a roundabout's ring lane (a `ring` step of the route). */
  pring: Uint8Array;
  /** Per frame slot: current speed and priority token held. */
  fvel: Float32Array;
  ftoken: Uint8Array;
  /** Set by `speedLimitAhead`: the limit it returned is a hold (yield/stop), not a follow. */
  held: boolean;
  heads: Int32Array;
  next: Int32Array;
  /** Per frame slot: `tick` of the last lookup whose path this vehicle's body was on. */
  mark: Int32Array;
  tick: number;
}

export function makePool(cap: number): Pool {
  return {
    id: new Uint32Array(cap),
    age: new Float32Array(cap),
    travelled: new Float32Array(cap),
    tripLength: new Float32Array(cap),
    stuck: new Float32Array(cap),
    retire: new Float32Array(cap),
    opacity: new Float32Array(cap).fill(1),
    route: new Int32Array(cap),
    dist: new Float32Array(cap),
    speed: new Float32Array(cap),
    vel: new Float32Array(cap),
    yaw: new Float32Array(cap),
    qx: new Float32Array(cap),
    qy: new Float32Array(cap),
    qz: new Float32Array(cap),
    qw: new Float32Array(cap).fill(1),
    length: new Float32Array(cap).fill(CAR_LENGTH),
    seg: new Int32Array(cap),
    tint: new Uint8Array(cap),
    lane: new Uint8Array(cap),
    stall: new Float32Array(cap),
    token: new Float32Array(cap),
    free: new Float32Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    z: new Float32Array(cap),
    hx: new Float32Array(cap),
    hz: new Float32Array(cap),
    count: 0,
  };
}

export const pose = createPose();
export const support = createPose();

/** Reused for spawn, movement and infrastructure changes. */
export function place(pool: Pool, i: number, g: LaneGeom): void {
  samplePose(g, pool.dist[i]!, pool.length[i]!, pose, support);
  pool.seg[i] = pose.segment;
  pool.x[i] = pose.x;
  pool.y[i] = pose.y + RIDE_HEIGHT;
  pool.z[i] = pose.z;
  pool.qx[i] = pose.qx;
  pool.qy[i] = pose.qy;
  pool.qz[i] = pose.qz;
  pool.qw[i] = pose.qw;
  pool.yaw[i] = Math.atan2(pose.fx, pose.fz);
  // Collision headings follow the local path tangent, as do anticipation probes.
  sampleTrajectory(g, pool.dist[i]!, support);
  const horizontal = Math.hypot(support.fx, support.fz);
  pool.hx[i] = horizontal > 1e-6 ? support.fx / horizontal : Math.sin(pool.yaw[i]!);
  pool.hz[i] = horizontal > 1e-6 ? support.fz / horizontal : Math.cos(pool.yaw[i]!);
}

export function moveVehicle(pool: Pool, dst: number, src: number): void {
  pool.id[dst] = pool.id[src]!;
  pool.age[dst] = pool.age[src]!;
  pool.travelled[dst] = pool.travelled[src]!;
  pool.tripLength[dst] = pool.tripLength[src]!;
  pool.stuck[dst] = pool.stuck[src]!;
  pool.retire[dst] = pool.retire[src]!;
  pool.opacity[dst] = pool.opacity[src]!;
  pool.route[dst] = pool.route[src]!;
  pool.dist[dst] = pool.dist[src]!;
  pool.speed[dst] = pool.speed[src]!;
  pool.vel[dst] = pool.vel[src]!;
  pool.yaw[dst] = pool.yaw[src]!;
  pool.qx[dst] = pool.qx[src]!;
  pool.qy[dst] = pool.qy[src]!;
  pool.qz[dst] = pool.qz[src]!;
  pool.qw[dst] = pool.qw[src]!;
  pool.length[dst] = pool.length[src]!;
  pool.seg[dst] = pool.seg[src]!;
  pool.tint[dst] = pool.tint[src]!;
  pool.lane[dst] = pool.lane[src]!;
  pool.stall[dst] = pool.stall[src]!;
  pool.token[dst] = pool.token[src]!;
  pool.free[dst] = pool.free[src]!;
  pool.x[dst] = pool.x[src]!;
  pool.y[dst] = pool.y[src]!;
  pool.z[dst] = pool.z[src]!;
  pool.hx[dst] = pool.hx[src]!;
  pool.hz[dst] = pool.hz[src]!;
}
