/** Stable source IDs, never vehicle pool indexes (swap-remove changes those). */
export interface RankedLight {
  id: string;
  score: number;
}

export function selectLights(
  candidates: RankedLight[],
  previous: ReadonlySet<string>,
  capacity: number,
): string[] {
  return candidates
    .filter((c) => Number.isFinite(c.score) && c.score > 0)
    .map((c) => ({ id: c.id, score: c.score * (previous.has(c.id) ? 1.25 : 1) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, capacity))
    .map((c) => c.id);
}

/** Reuses candidate records and output storage across the 5 Hz selection ticks. */
export class LightCandidates {
  private pool: RankedLight[] = [];
  private ranked: RankedLight[] = [];

  clear() {
    this.ranked.length = 0;
  }

  add(id: string, score: number) {
    if (!Number.isFinite(score) || score <= 0) {
      return;
    }
    const index = this.ranked.length;
    let candidate = this.pool[index];
    if (!candidate) {
      candidate = { id, score };
      this.pool[index] = candidate;
    }
    candidate.id = id;
    candidate.score = score;
    this.ranked.push(candidate);
  }

  select(previous: ReadonlySet<string>, capacity: number, output: Set<string>) {
    for (const candidate of this.ranked) {
      if (previous.has(candidate.id)) {
        candidate.score *= 1.25;
      }
    }
    this.ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (let i = 0; i < Math.min(this.ranked.length, Math.max(0, Math.floor(capacity))); i++) {
      output.add(this.ranked[i]!.id);
    }
  }
}

export class BrakeTracker {
  private speeds = new Map<number, { speed: number; hold: number }>();
  update(id: number, speed: number, dt: number): number {
    const previous = this.speeds.get(id);
    const braking = previous != null && dt > 0 && (previous.speed - speed) / dt > 0.3;
    const hold = braking ? 0.35 : Math.max(0, (previous?.hold ?? 0) - dt);
    this.speeds.set(id, { speed, hold });
    return hold > 0 || (previous != null && speed < 0.015) ? 1 : 0;
  }
  retain(ids: ReadonlySet<number>) {
    for (const id of this.speeds.keys()) {
      if (!ids.has(id)) {
        this.speeds.delete(id);
      }
    }
  }
  get size() {
    return this.speeds.size;
  }
}
