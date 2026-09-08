/** Caps whole scene updates, preserving real animation speed without catching up after sleep. */
export function createFrameClock(fps: number, initialSeconds = 0) {
  const interval = 1000 / fps;
  let due = 0;
  let last: number | null = null;
  let seconds = initialSeconds;
  return {
    tick(nowMs: number): number | null {
      if (last == null) {
        last = nowMs;
        due = nowMs + interval;
        return seconds;
      }
      if (nowMs + 0.1 < due) {
        return null;
      }
      seconds += Math.min(Math.max(0, nowMs - last) / 1000, 0.1);
      last = nowMs;
      due += Math.max(1, Math.floor((nowMs - due) / interval) + 1) * interval;
      return seconds;
    },
    pause() {
      last = null;
    },
  };
}
