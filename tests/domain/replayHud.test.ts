import { describe, expect, test } from "bun:test";
import { countAt, hudCounts, monthAt } from "@/domain/replayHud";
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
});
