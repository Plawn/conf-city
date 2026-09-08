export interface MobilityParticipant {
  step(dt: number): void;
  render(): void;
}

/** One bounded clock drives every transport; render only after all steps finish. */
export function createMobilityEngine() {
  const participants = new Set<MobilityParticipant>();
  const step = 1 / 30;
  let pending = 0;
  let seconds = 0;
  return {
    get seconds() {
      return seconds;
    },
    register(participant: MobilityParticipant) {
      participants.add(participant);
      return () => {
        participants.delete(participant);
      };
    },
    pause() {
      pending = 0;
    },
    advance(delta: number) {
      if (!Number.isFinite(delta) || delta < 0) {
        return;
      }
      pending = Math.min(pending + delta, step * 3);
      let changed = false;
      while (pending + 1e-8 >= step) {
        for (const participant of participants) {
          participant.step(step);
        }
        seconds += step;
        pending = Math.max(0, pending - step);
        changed = true;
      }
      if (changed) {
        for (const participant of participants) {
          participant.render();
        }
      }
    },
  };
}
