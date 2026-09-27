import { describe, expect, test } from "bun:test";
import { percentile } from "@/lib/stats";

describe("percentile", () => {
  test("p95 of a sorted sample", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([1], 0.95)).toBe(1);
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 0.5)).toBe(50);
  });
});
