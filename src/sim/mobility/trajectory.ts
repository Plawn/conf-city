/** Distance-based paths shared by road and rail. No renderer or simulation policy. */
export type Point3 = [number, number, number];

export interface Trajectory {
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  dirX: Float64Array;
  dirY: Float64Array;
  dirZ: Float64Array;
  cum: Float64Array;
  total: number;
  loop: boolean;
  /** Original segment for each retained segment, including after deduplication. */
  source: Uint32Array;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  segment: number;
}

export const createPose = (): Pose => ({
  x: 0,
  y: 0,
  z: 0,
  fx: 0,
  fy: 0,
  fz: 1,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  segment: 0,
});

export function buildTrajectory(points: Point3[], loop = false): Trajectory | null {
  if (points.some((p) => p.some((v) => !Number.isFinite(v)))) {
    return null;
  }
  const kept: Point3[] = [];
  const indices: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = kept[kept.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) > 1e-8) {
      kept.push(p);
      indices.push(i);
    }
  }
  if (kept.length < 2) {
    return null;
  }
  const first = kept[0]!;
  const last = kept[kept.length - 1]!;
  if (loop && Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) > 1e-8) {
    kept.push(first);
    indices.push(points.length);
  }
  const n = kept.length;
  const g: Trajectory = {
    px: Float64Array.from(kept, (p) => p[0]),
    py: Float64Array.from(kept, (p) => p[1]),
    pz: Float64Array.from(kept, (p) => p[2]),
    dirX: new Float64Array(n - 1),
    dirY: new Float64Array(n - 1),
    dirZ: new Float64Array(n - 1),
    cum: new Float64Array(n),
    source: new Uint32Array(n - 1),
    total: 0,
    loop,
  };
  for (let i = 0; i < n - 1; i++) {
    const dx = g.px[i + 1]! - g.px[i]!;
    const dy = g.py[i + 1]! - g.py[i]!;
    const dz = g.pz[i + 1]! - g.pz[i]!;
    const length = Math.hypot(dx, dy, dz);
    g.dirX[i] = dx / length;
    g.dirY[i] = dy / length;
    g.dirZ[i] = dz / length;
    g.cum[i + 1] = g.cum[i]! + length;
    g.source[i] = Math.max(0, indices[i + 1]! - 1);
  }
  g.total = g.cum[n - 1]!;
  return g.total > 1e-6 ? g : null;
}

export function pathDistance(g: Trajectory, distance: number): number {
  return g.loop
    ? ((distance % g.total) + g.total) % g.total
    : Math.max(0, Math.min(g.total, distance));
}

export function advanceDistance(
  g: Trajectory,
  distance: number,
  speed: number,
  dt: number,
): number {
  return pathDistance(g, distance + speed * dt);
}

export function segmentAt(g: Trajectory, distance: number, hint = 0): number {
  const last = g.cum.length - 2;
  if (
    hint >= 0 &&
    hint <= last &&
    distance >= g.cum[hint]! &&
    (distance < g.cum[hint + 1]! || hint === last)
  ) {
    return hint;
  }
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (distance >= g.cum[mid + 1]!) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Position and tangent; mutates caller-owned scratch and allocates nothing. */
export function sampleTrajectory(g: Trajectory, distance: number, out: Pose): Pose {
  const d = pathDistance(g, distance);
  const s = segmentAt(g, d, out.segment);
  const local = d - g.cum[s]!;
  out.segment = s;
  out.x = g.px[s]! + g.dirX[s]! * local;
  out.y = g.py[s]! + g.dirY[s]! * local;
  out.z = g.pz[s]! + g.dirZ[s]! * local;
  out.fx = g.dirX[s]!;
  out.fy = g.dirY[s]!;
  out.fz = g.dirZ[s]!;
  return out;
}

/** Front/rear support points orient +Z along the path, with pitch and no roll. */
export function samplePose(
  g: Trajectory,
  distance: number,
  length: number,
  out: Pose,
  scratch: Pose,
): Pose {
  sampleTrajectory(g, distance - length / 2, scratch);
  const x = scratch.x;
  const y = scratch.y;
  const z = scratch.z;
  sampleTrajectory(g, distance + length / 2, scratch);
  const dx = scratch.x - x;
  const dy = scratch.y - y;
  const dz = scratch.z - z;
  const magnitude = Math.hypot(dx, dy, dz);
  sampleTrajectory(g, distance, out);
  if (magnitude > 1e-8) {
    out.fx = dx / magnitude;
    out.fy = dy / magnitude;
    out.fz = dz / magnitude;
  }
  const yaw = Math.atan2(out.fx, out.fz);
  const pitch = -Math.atan2(out.fy, Math.hypot(out.fx, out.fz));
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const sp = Math.sin(pitch / 2);
  const cp = Math.cos(pitch / 2);
  out.qx = cy * sp;
  out.qy = sy * cp;
  out.qz = -sy * sp;
  out.qw = cy * cp;
  return out;
}

export function projectTrajectory(g: Trajectory, x: number, y: number, z: number): number {
  let best = Infinity;
  let distance = 0;
  for (let s = 0; s < g.dirX.length; s++) {
    const local = Math.max(
      0,
      Math.min(
        g.cum[s + 1]! - g.cum[s]!,
        (x - g.px[s]!) * g.dirX[s]! + (y - g.py[s]!) * g.dirY[s]! + (z - g.pz[s]!) * g.dirZ[s]!,
      ),
    );
    const gap =
      (x - g.px[s]! - g.dirX[s]! * local) ** 2 +
      (y - g.py[s]! - g.dirY[s]! * local) ** 2 +
      (z - g.pz[s]! - g.dirZ[s]! * local) ** 2;
    if (gap < best) {
      best = gap;
      distance = g.cum[s]! + local;
    }
  }
  return pathDistance(g, distance);
}
