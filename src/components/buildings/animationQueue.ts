export type AnimationStep = (time: number, delta: number, night: number) => boolean;

/** Sleeping tasks incur no per-frame calls; inputs or a lighting change wake them. */
export class AnimationQueue {
  private active = new Set<AnimationStep>();
  private nightSensitive = new Set<AnimationStep>();
  private night = Number.NaN;
  visits = 0;

  add(step: AnimationStep, nightSensitive = false) {
    this.active.add(step);
    if (nightSensitive) {
      this.nightSensitive.add(step);
    }
    return () => {
      this.active.delete(step);
      this.nightSensitive.delete(step);
    };
  }

  advance(time: number, delta: number, night: number) {
    if (night !== this.night) {
      this.night = night;
      for (const step of this.nightSensitive) {
        this.active.add(step);
      }
    }
    this.visits = 0;
    for (const step of this.active) {
      this.visits++;
      if (!step(time, delta, night)) {
        this.active.delete(step);
      }
    }
  }
}
