import { describe, expect, test } from "bun:test";
import { countAt, curveX, hudCounts, monthAt, servicesCurve } from "@/domain/replayHud";
import { parseScenario } from "@/domain/scenario";
import example from "../../public/scenarios/example.json";

describe("replay HUD", () => {
  const tl = parseScenario(example);

  test("a building counts once halfway up, and the counter rolls to it", () => {
    const [, span] = [...tl.nodes].find(([, s]) => s.from > 5)!;
    const before = hudCounts(tl, span.from + tl.rampSec * 0.4).nodes;
    const after = hudCounts(tl, span.from + tl.rampSec * 0.6).nodes;
    expect(after).toBeGreaterThan(before);
    const half = span.from + tl.rampSec * 0.5;
    const rolling = countAt(tl, half + 0.1, 0.3, "nodes");
    expect(rolling.previous).not.toBeNull();
    expect(rolling.k).toBeCloseTo(0.1 / 0.3, 1);
    expect(countAt(tl, half + 0.35, 0.3, "nodes").previous).toBeNull();
  });

  test("a month change slides over the fade, then holds", () => {
    let t = 0;
    while (monthAt(tl, t, 0.4).previous === null && t < tl.totalSec) {
      t += 1 / 30;
    }
    const start = monthAt(tl, t, 0.4);
    expect(start.previous).not.toBeNull();
    expect(start.k).toBeLessThan(0.2);
    expect(monthAt(tl, t + 0.2, 0.4).k).toBeGreaterThan(start.k);
    expect(monthAt(tl, t + 0.5, 0.4).previous).toBeNull();
  });

  test("the services curve steps with the counter over the scenario's dates", () => {
    const curve = servicesCurve(tl);
    expect(curve.steps[0]).toEqual({ x: 0, count: hudCounts(tl, tl.rampSec / 2 + 1e-3).nodes });
    for (let i = 1; i < curve.steps.length; i++) {
      expect(curve.steps[i]!.x).toBeGreaterThan(curve.steps[i - 1]!.x);
      expect(curve.steps[i]!.count).not.toBe(curve.steps[i - 1]!.count);
    }
    const last = curve.steps[curve.steps.length - 1]!;
    expect(last.x).toBeLessThanOrEqual(1);
    expect(last.count).toBe(hudCounts(tl, tl.outroAt).nodes);
    expect(curve.max).toBe(Math.max(...curve.steps.map((s) => s.count)));
    // The cursor follows the date: still through the intro, at the end from the outro on.
    expect(curveX(tl, 0)).toBe(0);
    expect(curveX(tl, tl.scenario.introSec!)).toBe(0);
    expect(curveX(tl, tl.outroAt)).toBe(1);
    expect(curveX(tl, tl.totalSec)).toBe(1);
    const cache = tl.nodes.get("paris-1/cache")!;
    expect(curveX(tl, cache.from)).toBeCloseTo((31 + 28) / 364, 3);
  });
});
