import { describe, expect, test } from "bun:test";
import { type CityUsage, worstUsage } from "@/domain/metrics/cityUsage";
import {
  allotPuffs,
  containerCount,
  PLUME_FALL_S,
  PLUME_RISE_S,
  plumeLevel,
  serviceSmoke,
  smokeRate,
  smokeSurge,
  tankLevel,
} from "@/domain/metrics/props";

function usage(p: Partial<CityUsage>): CityUsage {
  return {
    cpuUsedCores: 0,
    memUsedMb: 0,
    nodeCount: 1,
    fromHost: true,
    servicesCpuCores: 0,
    servicesMemUsedMb: 0,
    ...p,
  };
}

describe("worstUsage", () => {
  test("is the worst of the three machine percentages, as a 0..1 ratio", () => {
    expect(worstUsage(usage({ cpuPct: 12, memPct: 74, diskPct: 40 }))).toBeCloseTo(0.74, 6);
  });

  test("judges a machine on the figures it actually has", () => {
    // No disk mount: CPU and memory still decide, rather than a missing third
    // dragging the beacon to green.
    expect(worstUsage(usage({ cpuPct: 91, memPct: 30 }))).toBeCloseTo(0.91, 6);
    expect(worstUsage(usage({ diskPct: 55 }))).toBeCloseTo(0.55, 6);
  });

  test("nothing measured is a dark beacon, not a healthy one", () => {
    expect(worstUsage(usage({}))).toBeUndefined();
  });

  test("saturation past the capacity is kept, so a red stays red", () => {
    expect(worstUsage(usage({ cpuPct: 130, memPct: 20 }))).toBeCloseTo(1.3, 6);
  });
});

describe("the utility district's gauges", () => {
  test("nothing measured builds nothing: no smoke, no water, no boxes", () => {
    expect(smokeRate(undefined)).toBeUndefined();
    expect(tankLevel(undefined)).toBeUndefined();
    expect(containerCount(undefined, 12)).toBeUndefined();
  });

  test("the chimney goes from clear to full, and separates the low end", () => {
    expect(smokeRate(0)).toBe(0);
    expect(smokeRate(100)).toBe(1);
    // 20 % must read as "something is running", not as idle.
    expect(smokeRate(20)!).toBeGreaterThan(0.25);
    for (const [a, b] of [
      [0, 20],
      [20, 50],
      [50, 80],
      [80, 100],
    ] as const) {
      expect(smokeRate(b)! - smokeRate(a)!).toBeGreaterThan(0.1);
    }
  });

  test("the plume builds fast and dies away slowly", () => {
    const up = plumeLevel(0, 1, PLUME_RISE_S);
    const down = 1 - plumeLevel(1, 0, PLUME_RISE_S);
    expect(up).toBeGreaterThan(0.6);
    expect(down).toBeLessThan(0.15);
    // A spike still shows half a minute after the load is gone.
    expect(plumeLevel(1, 0, 30)).toBeGreaterThan(0.4);
    expect(plumeLevel(1, 0, PLUME_FALL_S * 6)).toBeLessThan(0.01);
    expect(plumeLevel(0.3, 0.3, 5)).toBeCloseTo(0.3, 9);
    expect(plumeLevel(0.5, 1, 0)).toBe(0.5);
    expect(plumeLevel(0.5, 1, -1)).toBe(0.5);
  });

  test("the surge is quiet under 75 %, full at 95 %, and monotone between", () => {
    expect(smokeSurge(undefined)).toBeUndefined();
    expect(smokeSurge(0)).toBe(0);
    expect(smokeSurge(75)).toBe(0);
    expect(smokeSurge(95)).toBe(1);
    expect(smokeSurge(130)).toBe(1);
    let prev = 0;
    for (let pct = 75; pct <= 95; pct++) {
      const s = smokeSurge(pct)!;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  test("the tank is empty at 0 and full at 100, and clamps beyond", () => {
    expect(tankLevel(0)).toBe(0);
    expect(tankLevel(50)).toBeCloseTo(0.5, 6);
    expect(tankLevel(100)).toBe(1);
    expect(tankLevel(140)).toBe(1);
    expect(tankLevel(-3)).toBe(0);
  });

  test("the quay fills up, then overflows on a nearly full disk", () => {
    expect(containerCount(0, 12)).toEqual({ count: 0, overflow: false });
    expect(containerCount(50, 12)).toEqual({ count: 6, overflow: false });
    expect(containerCount(94, 12)).toEqual({ count: 11, overflow: false });
    expect(containerCount(96, 12)).toEqual({ count: 12, overflow: true });
    expect(containerCount(100, 12)).toEqual({ count: 12, overflow: true });
  });
});

describe("service chimneys", () => {
  test("smoke follows absolute cores, log-eased", () => {
    expect(serviceSmoke(undefined)).toBeUndefined();
    expect(serviceSmoke(0)).toBe(0);
    expect(serviceSmoke(10)!).toBeGreaterThan(0.25);
    expect(serviceSmoke(10)!).toBeLessThan(0.35);
    expect(serviceSmoke(200)).toBe(1);
    expect(serviceSmoke(800)).toBe(1);
  });

  test("puffs follow each building's own smoke, so an idle city stays clear", () => {
    expect(allotPuffs([0, 0.03, 0.1], 160, 14)).toEqual([0, 0, 1]);
    expect(allotPuffs([0.5, 1], 160, 14)).toEqual([7, 14]);
  });

  test("over budget, the demand is scaled down and the hottest keep the most", () => {
    const out = allotPuffs([0, 0.1, 0.9, 1], 12, 14);
    expect(out[0]).toBe(0);
    expect(out.reduce((a, b) => a + b, 0)).toBe(12);
    expect(out[3]!).toBeGreaterThanOrEqual(out[2]!);
    expect(out[2]!).toBeGreaterThan(out[1]!);
    expect(out[1]!).toBeGreaterThanOrEqual(1);
  });

  test("a short budget goes to the hottest buildings first", () => {
    expect(allotPuffs([0.2, 0.8, 0.5], 2)).toEqual([0, 1, 1]);
    expect(allotPuffs([0.2, 0.8], 0)).toEqual([0, 0]);
    expect(allotPuffs([0, 0], 10)).toEqual([0, 0]);
  });
});
