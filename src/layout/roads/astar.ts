import { DIRECTIONS, edgeKey, type Grid, NO_DIR } from "./lattice";

/** Cost of an edge no route uses yet; a shared edge costs `SHARED_COST`. */
const FRESH_COST = 1;
const SHARED_COST = 0.6;
/** Paid at every change of direction: straight streets, not staircases. */
const TURN_COST = 0.5;

class Heap {
  private items: { id: number; f: number; seq: number }[] = [];
  private seq = 0;

  push(id: number, f: number): void {
    const item = { id, f, seq: this.seq++ };
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.items.length && this.less(l, best)) {
          best = l;
        }
        if (r < this.items.length && this.less(r, best)) {
          best = r;
        }
        if (best === i) {
          break;
        }
        this.swap(i, best);
        i = best;
      }
    }
    return top.id;
  }

  get size(): number {
    return this.items.length;
  }

  private less(a: number, b: number): boolean {
    const x = this.items[a]!;
    const y = this.items[b]!;
    return x.f < y.f || (x.f === y.f && x.seq < y.seq);
  }

  private swap(a: number, b: number): void {
    const tmp = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = tmp;
  }
}

/**
 * A* from any of `sources` to any of `targets` on the corner lattice, with the
 * incoming direction in the state so a turn can be charged. Returns the
 * corners from source to target, or `[]` when the grid does not connect them.
 */
export function routeCorners(
  sources: [number, number][],
  targets: [number, number][],
  grid: Grid,
  edgeUse: ReadonlyMap<string, number>,
): [number, number][] {
  const states = grid.width * grid.height * (NO_DIR + 1);
  const g = new Float64Array(states).fill(Infinity);
  const cameFrom = new Int32Array(states).fill(-1);
  const closed = new Uint8Array(states);
  const targetIds = new Set(targets.map(([i, j]) => grid.idOf(i, j)));
  const h = (ci: number, cj: number) => {
    let best = Infinity;
    for (const [ti, tj] of targets) {
      best = Math.min(best, Math.abs(ti - ci) + Math.abs(tj - cj));
    }
    return best * SHARED_COST;
  };
  const heap = new Heap();
  for (const [ci, cj] of sources) {
    const st = grid.idOf(ci, cj) * (NO_DIR + 1) + NO_DIR;
    g[st] = 0;
    heap.push(st, h(ci, cj));
  }

  let goal = -1;
  while (heap.size > 0) {
    const st = heap.pop()!;
    if (closed[st]) {
      continue;
    }
    closed[st] = 1;
    const id = Math.floor(st / (NO_DIR + 1));
    const dirIn = st % (NO_DIR + 1);
    if (targetIds.has(id)) {
      goal = st;
      break;
    }
    const ci = grid.loI + (id % grid.width);
    const cj = grid.loJ + Math.floor(id / grid.width);
    for (let d = 0; d < DIRECTIONS.length; d++) {
      const [di, dj] = DIRECTIONS[d]!;
      const ni = ci + di;
      const nj = cj + dj;
      if (!grid.inGrid(ni, nj)) {
        continue;
      }
      const step = edgeUse.has(edgeKey(ci, cj, di, dj)) ? SHARED_COST : FRESH_COST;
      const turn = dirIn !== NO_DIR && dirIn !== d ? TURN_COST : 0;
      const nst = grid.idOf(ni, nj) * (NO_DIR + 1) + d;
      const ng = g[st]! + step + turn;
      if (ng < g[nst]!) {
        g[nst] = ng;
        cameFrom[nst] = st;
        heap.push(nst, ng + h(ni, nj));
      }
    }
  }
  if (goal < 0) {
    return [];
  }

  const out: [number, number][] = [];
  for (let st = goal; st >= 0; st = cameFrom[st]!) {
    const id = Math.floor(st / (NO_DIR + 1));
    out.push([grid.loI + (id % grid.width), grid.loJ + Math.floor(id / grid.width)]);
  }
  return out.reverse();
}
