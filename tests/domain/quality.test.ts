import { describe, expect, test } from "bun:test";
import {
  createGovernor,
  frameBudgetMs,
  initialTier,
  isIdle,
  MAX_CLUSTERED_LIGHTS,
  QUALITY_PROFILES,
  QUALITY_TIERS,
  resolveDpr,
  stepTier,
} from "@/domain/quality";

describe("quality profiles", () => {
  test("the clustered node holds the widest tier's points plus a spot pair per slot", () => {
    expect(MAX_CLUSTERED_LIGHTS).toBe(1056);
  });
  test("every budget is monotonic from eco to high", () => {
    const [eco, balanced, high] = QUALITY_TIERS.map((tier) => QUALITY_PROFILES[tier]);
    for (const key of [
      "maxPixels",
      "maxDpr",
      "shadowMapSize",
      "shadowHz",
      "pointLights",
      "vehicleSpots",
      "maxCars",
      "maxTrucks",
    ] as const) {
      expect(eco![key]).toBeLessThanOrEqual(balanced![key]);
      expect(balanced![key]).toBeLessThanOrEqual(high![key]);
    }
    expect(eco!.ao.enabled).toBe(false);
    expect(eco!.volume).toBe(false);
    expect(eco!.beaconShadow).toBe(false);
    expect(high!.ao.samples).toBe(16);
  });

  test("high keeps the reference look", () => {
    const high = QUALITY_PROFILES.high;
    expect(high.maxDpr).toBe(2);
    expect(high.shadowMapSize).toBe(2048);
    expect(high.pointLights).toBe(1024);
    expect(high.vehicleSpots).toBe(16);
    expect(high.maxCars).toBe(240);
  });

  test("stepTier saturates at both ends", () => {
    expect(stepTier("eco", -1)).toBe("eco");
    expect(stepTier("eco", 1)).toBe("balanced");
    expect(stepTier("high", 1)).toBe("high");
  });
});

describe("render scale", () => {
  test("a 1080p classic screen renders native in balanced and high", () => {
    expect(resolveDpr(QUALITY_PROFILES.balanced, 1920, 1080, 1)).toBe(1);
    expect(resolveDpr(QUALITY_PROFILES.high, 1920, 1080, 1)).toBe(1);
  });

  test("eco trims a 1080p screen to its pixel cap", () => {
    const scale = resolveDpr(QUALITY_PROFILES.eco, 1920, 1080, 1);
    expect(scale).toBe(0.75);
    expect(1920 * 1080 * scale * scale).toBeLessThanOrEqual(QUALITY_PROFILES.eco.maxPixels);
  });

  test("high-DPI displays respect the per-tier ratio cap", () => {
    expect(resolveDpr(QUALITY_PROFILES.eco, 1440, 900, 2)).toBe(0.95);
    expect(resolveDpr(QUALITY_PROFILES.balanced, 1440, 900, 2)).toBe(1.35);
    expect(resolveDpr(QUALITY_PROFILES.high, 1440, 900, 2)).toBe(1.95);
  });

  test("4K at DPR 1 is capped by pixels, never below the floor", () => {
    expect(resolveDpr(QUALITY_PROFILES.high, 3840, 2160, 1)).toBe(0.75);
    expect(resolveDpr(QUALITY_PROFILES.eco, 3840, 2160, 1)).toBe(0.5);
    expect(resolveDpr(QUALITY_PROFILES.eco, 0, 0, 0)).toBe(1);
  });

  test("scale is quantised so layout jitter does not resize the canvas", () => {
    const a = resolveDpr(QUALITY_PROFILES.balanced, 1900, 1200, 1.5);
    const b = resolveDpr(QUALITY_PROFILES.balanced, 1904, 1200, 1.5);
    expect(a).toBe(1);
    expect(a).toBe(b);
  });
});

describe("initial tier", () => {
  const base = { vendor: "", renderer: "", architecture: "", isFallbackAdapter: null };
  test("software adapters start in eco", () => {
    expect(initialTier({ ...base, backend: "webgpu", isFallbackAdapter: true })).toBe("eco");
    expect(
      initialTier({
        ...base,
        backend: "webgl",
        renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))",
      }),
    ).toBe("eco");
  });

  test("integrated Intel starts balanced on WebGPU and eco on WebGL2", () => {
    expect(
      initialTier({ ...base, backend: "webgpu", vendor: "intel", architecture: "gen-9" }),
    ).toBe("balanced");
    expect(
      initialTier({
        ...base,
        backend: "webgl",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620)",
      }),
    ).toBe("eco");
    expect(
      initialTier({ ...base, backend: "webgpu", vendor: "intel", architecture: "gen-9", cores: 4 }),
    ).toBe("eco");
  });

  test("discrete and Apple GPUs start high", () => {
    expect(
      initialTier({ ...base, backend: "webgpu", vendor: "nvidia", architecture: "ampere" }),
    ).toBe("high");
    expect(
      initialTier({ ...base, backend: "webgpu", vendor: "apple", architecture: "metal-3" }),
    ).toBe("high");
    expect(initialTier({ ...base, backend: "webgpu", vendor: "amd", architecture: "rdna-2" })).toBe(
      "high",
    );
  });

  test("unknown adapters start balanced; WebGL2 never starts high", () => {
    expect(initialTier({ ...base, backend: "webgpu", vendor: "amd", architecture: "gcn-5" })).toBe(
      "balanced",
    );
    expect(initialTier({ ...base, backend: "webgl", renderer: "NVIDIA GeForce RTX 3060" })).toBe(
      "balanced",
    );
  });
});

/** Feed `ms` of frames at a fixed interval; returns the tier changes decided. */
function run(
  governor: ReturnType<typeof createGovernor>,
  from: number,
  ms: number,
  intervalMs: number,
  idle = false,
) {
  const changes: string[] = [];
  for (let t = from + intervalMs; t <= from + ms; t += intervalMs) {
    const next = governor.observe(t, intervalMs, idle);
    if (next) {
      changes.push(next);
    }
  }
  return changes;
}

describe("quality governor", () => {
  const budget = frameBudgetMs(30);

  test("steps down after three seconds over budget, then respects the cooldown", () => {
    const governor = createGovernor({ budgetMs: budget, initial: "high", now: 0 });
    expect(run(governor, 0, 2_500, 50)).toEqual([]);
    expect(run(governor, 2_500, 1_500, 50)).toEqual(["balanced"]);
    expect(governor.tier).toBe("balanced");
    // Still slow: the next step waits for the cooldown, not another three seconds.
    expect(run(governor, 4_000, 8_500, 50)).toEqual([]);
    expect(run(governor, 12_500, 4_000, 50)).toEqual(["eco"]);
    expect(run(governor, 16_500, 60_000, 50)).toEqual([]);
    expect(governor.changes.map((c) => c.to)).toEqual(["balanced", "eco"]);
  });

  test("holding the cadence steps up only after thirty seconds", () => {
    const governor = createGovernor({ budgetMs: budget, initial: "balanced", now: 0 });
    expect(run(governor, 0, 25_000, 33.4)).toEqual([]);
    expect(run(governor, 25_000, 10_000, 33.4)).toEqual(["high"]);
    expect(governor.tier).toBe("high");
  });

  test("never climbs above the ceiling", () => {
    const governor = createGovernor({ budgetMs: budget, initial: "eco", now: 0 });
    expect(run(governor, 0, 40_000, 33.4)).toEqual(["balanced"]);
    expect(run(governor, 40_000, 120_000, 33.4)).toEqual([]);
    expect(governor.tier).toBe("balanced");
  });

  test("a failed probe lowers the ceiling instead of oscillating", () => {
    const governor = createGovernor({ budgetMs: budget, initial: "balanced", now: 0 });
    expect(run(governor, 0, 35_000, 33.4)).toEqual(["high"]);
    expect(run(governor, 35_000, 6_000, 60)).toEqual(["balanced"]);
    expect(governor.ceiling).toBe("balanced");
    expect(run(governor, 41_000, 120_000, 33.4)).toEqual([]);
  });

  test("a genuine slowdown long after a step up keeps the ceiling", () => {
    const governor = createGovernor({ budgetMs: budget, initial: "balanced", now: 0 });
    expect(run(governor, 0, 35_000, 33.4)).toEqual(["high"]);
    expect(run(governor, 35_000, 90_000, 33.4)).toEqual([]);
    expect(run(governor, 125_000, 6_000, 60)).toEqual(["balanced"]);
    expect(governor.ceiling).toBe("high");
    expect(run(governor, 131_000, 40_000, 33.4)).toEqual(["high"]);
  });

  test("idle frames, outliers and the settle window are not evidence", () => {
    const governor = createGovernor({ budgetMs: budget, initial: "high", now: 0 });
    expect(run(governor, 0, 20_000, 66.7, true)).toEqual([]);
    for (let t = 20_100; t < 30_000; t += 100) {
      // Fast frames interrupted by long pauses: pauses are dropped, the rest holds.
      expect(governor.observe(t, t % 1000 === 0 ? 800 : 33.4)).toBeNull();
    }
    expect(governor.tier).toBe("high");
    const slow = createGovernor({ budgetMs: budget, initial: "high", now: 0 });
    expect(run(slow, 0, 4_000, 50)).toEqual(["balanced"]);
    // Frames right after a change include recompilation and are discarded.
    expect(run(slow, 4_000, 1_500, 200)).toEqual([]);
    expect(slow.tier).toBe("balanced");
  });

  test("a budget change discards the window", () => {
    const governor = createGovernor({ budgetMs: frameBudgetMs(60), initial: "high", now: 0 });
    expect(run(governor, 0, 2_500, 33.4)).toEqual([]);
    governor.setBudget(frameBudgetMs(30));
    expect(run(governor, 2_500, 10_000, 33.4)).toEqual([]);
    expect(governor.tier).toBe("high");
  });
});

describe("idle detection", () => {
  test("an unfocused window is idle at once; a focused one after the timeout", () => {
    expect(isIdle(1_000, 0, false)).toBe(true);
    expect(isIdle(1_000, 0, true)).toBe(false);
    expect(isIdle(120_000, 0, true)).toBe(true);
    expect(isIdle(119_999, 0, true)).toBe(false);
  });
});
