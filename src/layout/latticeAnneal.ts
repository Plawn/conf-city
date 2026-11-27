import { mulberry32 } from "../lib/random";

/**
 * Seeded simulated annealing of buildings on the lattice, run after the greedy snap.
 *
 * The force relaxation gives the city its overall shape, but rounding it cell by cell
 * scatters neighbourhoods and stretches links. This pass moves or swaps buildings
 * between nearby cells to lower a cost that reads like a planner's brief:
 * short links (and never a diagonal one — it gets no street), neighbourhoods as
 * contiguous patches, a little breathing room between different neighbourhoods,
 * and a compact blob — packed at its core, airier towards its edge. Pure and deterministic: same input, same seed, same city.
 */

export interface AnnealBody {
  cell: [number, number];
  /** Neighbourhood key; `""` for ungrouped buildings. */
  group: string;
  /** Pinned in place, still counts as an obstacle and a neighbour. */
  fixed?: boolean;
}

export interface AnnealOptions {
  seed: number;
  /** Linked pairs, as body indices. */
  links: [number, number][];
  /** Centre the blob is pulled towards (cell units). */
  center: [number, number];
  /** Packed island: no room for gaps between neighbourhoods, stronger pull to the centre. */
  dense?: boolean;
  /** Move attempts per movable body. */
  sweeps?: number;
}

/** A diagonal link shares a single corner with its peer: no street, so it costs as much as a detour. */
const DIAGONAL_PENALTY = 2;
/** Same rest length as the force springs (`LINK_REST`): two cells, a street between the plots. */
const LINK_SHORT = 2;
/**
 * A linked pair on neighbouring cells is too thin for its own street: worse than the
 * rest length even after both sides cash in their same-neighbourhood reward.
 */
const ADJACENT_COST = 4;
const MOVE_RADIUS = 2;

/** Numeric cell key: the inner loop runs tens of thousands of times, strings would dominate it. */
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

interface Weights {
  link: number;
  same: number;
  diff: number;
  group: number;
  center: number;
  /** Crowding cost at the edge of the blob: a dense core, airier outskirts. */
  sprawl: number;
}

function weights(dense: boolean): Weights {
  return dense
    ? { link: 1, same: 0.8, diff: 0.2, group: 0.35, center: 0.12, sprawl: 0 }
    : { link: 1, same: 0.8, diff: 0.6, group: 0.35, center: 0.06, sprawl: 1.5 };
}

/** Anneals `bodies` in place; only their `cell` changes. */
export function annealLattice(bodies: AnnealBody[], opts: AnnealOptions): void {
  const movable = bodies.map((b, i) => (b.fixed ? -1 : i)).filter((i) => i >= 0);
  if (movable.length === 0) {
    return;
  }
  const w = weights(opts.dense ?? false);
  const rand = mulberry32(opts.seed);
  const occupied = new Map<number, number>();
  bodies.forEach((b, i) => {
    occupied.set(key(b.cell[0], b.cell[1]), i);
  });
  // Radius (cells) of a round blob of this many buildings: past it a neighbour costs `sprawl`.
  // A small city is all core: the outskirts only open up past ~10 buildings.
  const blob = Math.sqrt(bodies.length / Math.PI) + 0.5;
  const sprawl = w.sprawl * Math.min(1, Math.max(0, (bodies.length - 10) / 20));
  const outskirts = (cell: [number, number]) => {
    const r = Math.min(1, Math.hypot(cell[0] - opts.center[0], cell[1] - opts.center[1]) / blob);
    return sprawl * r * r;
  };
  const adjacency: number[][] = bodies.map(() => []);
  for (const [a, b] of opts.links) {
    adjacency[a]?.push(b);
    adjacency[b]?.push(a);
  }

  const centroids = new Map<string, [number, number]>();
  const refreshCentroids = () => {
    const acc = new Map<string, [number, number, number]>();
    for (const b of bodies) {
      if (!b.group) {
        continue;
      }
      const s = acc.get(b.group) ?? [0, 0, 0];
      s[0] += b.cell[0];
      s[1] += b.cell[1];
      s[2] += 1;
      acc.set(b.group, s);
    }
    centroids.clear();
    for (const [g, s] of acc) {
      centroids.set(g, [s[0] / s[2], s[1] / s[2]]);
    }
  };

  /** Every term of the total cost that involves body `k`, with `k` standing on `cell`. */
  const local = (k: number, cell: [number, number], ignore = -1): number => {
    const body = bodies[k]!;
    let cost = 0;
    for (const m of adjacency[k]!) {
      if (m === ignore) {
        continue;
      }
      const o = bodies[m]!.cell;
      const di = Math.abs(cell[0] - o[0]);
      const dj = Math.abs(cell[1] - o[1]);
      const len = di + dj;
      const shaped = len === 1 ? ADJACENT_COST : Math.max(len, LINK_SHORT);
      cost += w.link * (shaped + (di === 1 && dj === 1 ? DIAGONAL_PENALTY : 0));
    }
    const crowd = outskirts(cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (di === 0 && dj === 0) {
          continue;
        }
        const m = occupied.get(key(cell[0] + di, cell[1] + dj));
        if (m === undefined || m === k || m === ignore) {
          continue;
        }
        const reach = di === 0 || dj === 0 ? 1 : 0.5;
        cost += crowd * reach;
        const other = bodies[m]!.group;
        if (other === body.group) {
          cost -= w.same * reach;
        } else {
          cost += w.diff * reach * (other && body.group ? 1 : 0.5);
        }
      }
    }
    const g = body.group ? centroids.get(body.group) : undefined;
    if (g) {
      cost += w.group * (Math.abs(cell[0] - g[0]) + Math.abs(cell[1] - g[1]));
    }
    cost += w.center * ((cell[0] - opts.center[0]) ** 2 + (cell[1] - opts.center[1]) ** 2);
    return cost;
  };

  const sweeps = opts.sweeps ?? 300;
  const steps = sweeps * movable.length;
  const t0 = 1.5;
  const t1 = 0.01;
  const span = 2 * MOVE_RADIUS + 1;
  refreshCentroids();
  for (let s = 0; s < steps; s++) {
    if (s % movable.length === 0) {
      refreshCentroids();
    }
    // Final tenth is a pure descent: the city settles into a local optimum.
    const progress = s / steps;
    const temperature = progress > 0.9 ? 0 : t0 * (t1 / t0) ** (progress / 0.9);
    const k = movable[Math.floor(rand() * movable.length)]!;
    const from = bodies[k]!.cell;
    const di = Math.floor(rand() * span) - MOVE_RADIUS;
    const dj = Math.floor(rand() * span) - MOVE_RADIUS;
    if (di === 0 && dj === 0) {
      continue;
    }
    const to: [number, number] = [from[0] + di, from[1] + dj];
    const toKey = key(to[0], to[1]);
    const fromKey = key(from[0], from[1]);
    const l = occupied.get(toKey);
    if (l !== undefined && bodies[l]!.fixed) {
      continue;
    }
    let delta: number;
    if (l === undefined) {
      const before = local(k, from);
      occupied.delete(fromKey);
      const after = local(k, to);
      occupied.set(fromKey, k);
      delta = after - before;
    } else {
      // The k–l terms are the same before and after a swap, so they are left out.
      const before = local(k, from, l) + local(l, to, k);
      occupied.set(fromKey, l);
      occupied.set(toKey, k);
      bodies[k]!.cell = to;
      bodies[l]!.cell = from;
      const after = local(k, to, l) + local(l, from, k);
      occupied.set(fromKey, k);
      occupied.set(toKey, l);
      bodies[k]!.cell = from;
      bodies[l]!.cell = to;
      delta = after - before;
    }
    const accept = delta <= 0 || (temperature > 0 && rand() < Math.exp(-delta / temperature));
    if (!accept) {
      continue;
    }
    if (l === undefined) {
      occupied.delete(fromKey);
      occupied.set(toKey, k);
      bodies[k]!.cell = to;
    } else {
      occupied.set(fromKey, l);
      occupied.set(toKey, k);
      bodies[k]!.cell = to;
      bodies[l]!.cell = from;
    }
  }
}
