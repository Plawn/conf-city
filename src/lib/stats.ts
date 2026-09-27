/** Nearest-rank percentile of an ascending `sorted` array; 0 when empty. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** Arithmetic mean; 0 when empty. */
export function mean(values: readonly number[]): number {
  return sum(values) / Math.max(1, values.length);
}
