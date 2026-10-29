import { describe, expect, test } from "bun:test";
import {
  BLAST_POP,
  BLAST_SEC,
  blastShards,
  buildingBlastScale,
  fireballAt,
  shardAt,
} from "@/domain/blast";

describe("blast", () => {
  test("the building swells, then is gone", () => {
    expect(buildingBlastScale(0)).toEqual([1, 1]);
    expect(buildingBlastScale(BLAST_POP / 2)[0]).toBeGreaterThan(1);
    expect(buildingBlastScale(BLAST_POP)).toEqual([0, 0]);
  });

  test("debris are seeded, fly, land on the ground and fade out", () => {
    expect(blastShards("a/b", 8)).toEqual(blastShards("a/b", 8));
    expect(blastShards("a/b", 8)).not.toEqual(blastShards("a/c", 8));
    const out = { x: 0, y: 0, z: 0, roll: 0, scale: 0 };
    for (const s of blastShards("a/b", 20)) {
      shardAt(s, 0.5, 1, 2, out);
      expect(out.y).toBeGreaterThanOrEqual(0);
      shardAt(s, BLAST_SEC * 0.85, 1, 2, out);
      expect(out.y).toBe(0);
      shardAt(s, BLAST_SEC, 1, 2, out);
      expect(out.scale).toBe(0);
    }
  });

  test("the fireball flashes hot, then cools and vanishes", () => {
    expect(fireballAt(0).radius).toBe(0);
    const early = fireballAt(0.15);
    const late = fireballAt(0.8);
    expect(early.heat).toBeGreaterThan(late.heat);
    expect(early.radius).toBeGreaterThan(0);
    expect(fireballAt(1.5).radius).toBe(0);
  });
});
