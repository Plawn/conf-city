// Random walks and a Markov liveness chain — the dummy's only sources of change.

import type { LivenessStatus } from "../../protocol.ts";

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function walk(current: number, step: number, lo: number, hi: number) {
  return clamp(current + (Math.random() - 0.5) * 2 * step, lo, hi);
}

/** Markov transition: given current liveness, return next state. */
export function transitionLiveness(current: LivenessStatus): LivenessStatus {
  const r = Math.random();
  const transitions: Record<LivenessStatus, [number, LivenessStatus][]> = {
    healthy: [
      [0.01, "down"],
      [0.05, "degraded"],
    ],
    degraded: [
      [0.1, "down"],
      [0.4, "healthy"],
    ],
    down: [
      [0.3, "degraded"],
      [0.5, "healthy"],
    ],
    unknown: [[0.5, "healthy"]],
  };
  for (const [threshold, next] of transitions[current]) {
    if (r < threshold) {
      return next;
    }
  }
  return current;
}
