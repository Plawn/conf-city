/**
 * Deterministic position-based relaxation, used both for buildings inside a city
 * and for islands inside the world.
 *
 * No randomness, no time: the caller seeds the initial positions and the result
 * is a pure function of them. Each iteration applies springs, soft repulsion,
 * optional group cohesion / centring / bias, then a **hard** collision pass so
 * the final layout never overlaps. Cooling is linear. O(n²) per iteration, which
 * is fine up to a few hundred bodies per city.
 */

export interface Body {
  x: number;
  z: number;
  /** Collision radius. */
  r: number;
  /** Immovable obstacle (e.g. static nodes while placing discovered ones). */
  fixed?: boolean;
  /** Cohesion key: bodies sharing it are pulled towards their common centroid. */
  group?: string;
}

export interface Spring {
  a: number;
  b: number;
  rest: number;
  /** Relative stiffness, default 1. */
  k?: number;
}

export interface RelaxOptions {
  iterations?: number;
  /** Spring stiffness. */
  springK?: number;
  /** Soft repulsion strength, applied below `r_a + r_b + repelPadding`. */
  repelK?: number;
  repelPadding?: number;
  /** Neighbourhood cohesion strength (0 disables it). */
  groupK?: number;
  /** Pull towards the centroid of everything, keeps the blob compact. */
  centerK?: number;
  /** Constant push, e.g. `[0, 1]` to drift southwards. */
  bias?: [number, number];
  biasK?: number;
  /** Extra clearance enforced by the hard collision pass. */
  collisionMargin?: number;
}

/** Deterministic tie-break direction for two bodies sitting on the exact same spot. */
function nudge(i: number, j: number): [number, number] {
  const angle = ((i * 2 + j) % 16) * (Math.PI / 8);
  return [Math.cos(angle) * 0.01, Math.sin(angle) * 0.01];
}

/** Relaxes `bodies` in place. */
export function relax(bodies: Body[], springs: Spring[], opts: RelaxOptions = {}): void {
  const iterations = opts.iterations ?? 250;
  const springK = opts.springK ?? 0.35;
  const repelK = opts.repelK ?? 0.5;
  const repelPadding = opts.repelPadding ?? 2;
  const groupK = opts.groupK ?? 0;
  const centerK = opts.centerK ?? 0.004;
  const biasK = opts.biasK ?? 0;
  const bias = opts.bias ?? [0, 0];
  const collisionMargin = opts.collisionMargin ?? 0;
  const n = bodies.length;
  if (n === 0) {
    return;
  }

  for (let it = 0; it < iterations; it++) {
    const t = 1 - it / iterations;

    for (const s of springs) {
      const a = bodies[s.a];
      const b = bodies[s.b];
      if (!a || !b) {
        continue;
      }
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-6) {
        const [nx, nz] = nudge(s.a, s.b);
        dx = nx;
        dz = nz;
        d = Math.hypot(dx, dz);
      }
      const push = ((d - s.rest) / d) * springK * (s.k ?? 1) * t * 0.5;
      if (!a.fixed) {
        a.x += dx * push;
        a.z += dz * push;
      }
      if (!b.fixed) {
        b.x -= dx * push;
        b.z -= dz * push;
      }
    }

    for (let i = 0; i < n; i++) {
      const a = bodies[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j]!;
        const range = a.r + b.r + repelPadding;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= range) {
          continue;
        }
        if (d < 1e-6) {
          const [nx, nz] = nudge(i, j);
          dx = nx;
          dz = nz;
          d = Math.hypot(dx, dz);
        }
        const push = ((range - d) / d) * repelK * t * 0.5;
        if (!a.fixed) {
          a.x -= dx * push;
          a.z -= dz * push;
        }
        if (!b.fixed) {
          b.x += dx * push;
          b.z += dz * push;
        }
      }
    }

    if (groupK > 0) {
      const sums = new Map<string, [number, number, number]>();
      for (const b of bodies) {
        if (!b.group) {
          continue;
        }
        const acc = sums.get(b.group);
        if (acc) {
          acc[0] += b.x;
          acc[1] += b.z;
          acc[2] += 1;
        } else {
          sums.set(b.group, [b.x, b.z, 1]);
        }
      }
      for (const b of bodies) {
        if (b.fixed || !b.group) {
          continue;
        }
        const acc = sums.get(b.group);
        if (!acc || acc[2] < 2) {
          continue;
        }
        b.x += (acc[0] / acc[2] - b.x) * groupK * t;
        b.z += (acc[1] / acc[2] - b.z) * groupK * t;
      }
    }

    if (centerK > 0 || biasK > 0) {
      let cx = 0,
        cz = 0;
      for (const b of bodies) {
        cx += b.x;
        cz += b.z;
      }
      cx /= n;
      cz /= n;
      for (const b of bodies) {
        if (b.fixed) {
          continue;
        }
        if (centerK > 0) {
          b.x += (cx - b.x) * centerK * t;
          b.z += (cz - b.z) * centerK * t;
        }
        if (biasK > 0) {
          b.x += bias[0] * biasK * t;
          b.z += bias[1] * biasK * t;
        }
      }
    }

    // Hard separation: the invariant the rest of the pipeline relies on.
    for (let i = 0; i < n; i++) {
      const a = bodies[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j]!;
        const min = a.r + b.r + collisionMargin;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= min) {
          continue;
        }
        if (d < 1e-6) {
          const [nx, nz] = nudge(i, j);
          dx = nx;
          dz = nz;
          d = Math.hypot(dx, dz);
        }
        const correction = (min - d) / d;
        if (a.fixed && b.fixed) {
          continue;
        }
        const share = a.fixed || b.fixed ? 1 : 0.5;
        if (!a.fixed) {
          a.x -= dx * correction * share;
          a.z -= dz * correction * share;
        }
        if (!b.fixed) {
          b.x += dx * correction * share;
          b.z += dz * correction * share;
        }
      }
    }
  }
}
