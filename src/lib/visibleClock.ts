/** Wall time for observed congestion: independent of simulation speed, paused when hidden. */
export function createVisibleClock() {
  let previous: number | null = null;
  return {
    pause() {
      previous = null;
    },
    tick(nowMs: number): number {
      const dt = previous == null ? 0 : Math.max(0, (nowMs - previous) / 1000);
      previous = nowMs;
      // An unobserved gap (computer sleep or a blocked main thread) is not evidence of a jam.
      return dt > 5 ? 0 : dt;
    },
  };
}
