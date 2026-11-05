import { describe, expect, test } from "bun:test";
import {
  MIN_HOLD,
  ORBIT_DEG_PER_SEC,
  planShots,
  type ShotKey,
  shotAt,
  TRANSITION,
} from "@/domain/director";
import { parseScenario } from "@/domain/scenario";
import { CLOUD_ALTITUDE } from "@/layout/cloud";
import { layoutWorld } from "@/layout/layoutWorld";
import { loadWorld } from "@/loaders/loadWorld";
import example from "../../public/scenarios/example.json";

/** Longest camera move (s). */
const MAX_MOVE = 3.4;

describe("director", () => {
  const tl = parseScenario(example);
  const { nodes, links } = loadWorld(tl.world);
  const layout = layoutWorld(
    tl.world.cities.map((c) => c.id),
    nodes,
    links,
  );
  const keys = planShots(tl, layout);

  test("shots are spaced by at least one camera move", () => {
    expect(keys.length).toBeGreaterThan(2);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]!.duration).toBeGreaterThanOrEqual(TRANSITION);
      expect(keys[i]!.t - keys[i - 1]!.t).toBeGreaterThanOrEqual(keys[i - 1]!.duration - 1e-9);
    }
  });

  test("a farther move takes longer", () => {
    const moves = keys.slice(1).map((k, i) => ({
      far: Math.hypot(k.lookAt[0] - keys[i]!.lookAt[0], k.lookAt[2] - keys[i]!.lookAt[2]),
      duration: k.duration,
    }));
    const near = moves.reduce((a, b) => (a.far < b.far ? a : b));
    const far = moves.reduce((a, b) => (a.far > b.far ? a : b));
    expect(far.duration).toBeGreaterThan(near.duration);
  });

  test("the camera never stops dead between two framings", () => {
    // Velocity is continuous: consecutive per-frame steps differ by a small fraction.
    const step = 1 / 60;
    const at = (t: number) => shotAt(keys, t)!.lookAt;
    for (let t = step; t < tl.totalSec - 2 * step; t += step) {
      const [a, b, c] = [at(t - step), at(t), at(t + step)];
      const v0 = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const v1 = Math.hypot(c[0] - b[0], c[2] - b[2]);
      expect(Math.abs(v1 - v0)).toBeLessThan(0.02);
    }
  });

  test("a demolition gets its own close-up, held through the blast", () => {
    const legacy = tl.nodes.get("paris-1/legacy-db")!.to;
    const node = layout.nodes.find((n) => n.id === "legacy-db")!;
    const pose = shotAt(keys, legacy + 0.5)!;
    expect(
      Math.hypot(pose.lookAt[0] - node.position[0], pose.lookAt[2] - node.position[2]),
    ).toBeLessThan(4);
    const shot = keys.findLast((k) => k.t <= legacy)!;
    expect(keys[keys.indexOf(shot) + 1]!.t).toBeGreaterThanOrEqual(legacy + 1.5);
  });

  test("the pose is continuous and deterministic", () => {
    let prev = shotAt(keys, 0)!;
    for (let t = 1 / 60; t < tl.totalSec; t += 1 / 60) {
      const pose = shotAt(keys, t)!;
      const jump = Math.hypot(
        pose.position[0] - prev.position[0],
        pose.position[1] - prev.position[1],
        pose.position[2] - prev.position[2],
      );
      expect(jump).toBeLessThan(2);
      prev = pose;
    }
    expect(shotAt(keys, 12.34)).toEqual(shotAt(keys, 12.34));
  });

  test("ends on a frame holding every island alive", () => {
    const last = keys[keys.length - 1]!;
    const london = layout.cities.get("london-1")!.center;
    const paris = layout.cities.get("paris-1")!.center;
    expect(last.lookAt[0]).toBeCloseTo(
      (Math.min(london[0], paris[0]) + Math.max(london[0], paris[0])) / 2,
      -1,
    );
  });
});

describe("director, cloud services", () => {
  const tl = parseScenario({
    title: "Sky",
    start: "2026-01-01",
    end: "2026-12-31",
    durationSec: 40,
    cities: [
      {
        id: "tools",
        name: "Tools",
        nodes: [
          { id: "api", type: "app", label: "API", links: [] },
          { id: "llm", type: "app", label: "LLM", links: [] },
          { id: "web", type: "app", label: "Web", links: [], since: "2026-06-05" },
          { id: "jobs", type: "app", label: "Jobs", links: [], since: "2026-06-12" },
        ],
      },
      {
        id: "azure",
        name: "Azure",
        cloud: true,
        since: "2026-06-01",
        nodes: [{ id: "openai", type: "app", label: "OpenAI", links: [], since: "2026-06-15" }],
      },
    ],
    links: [{ from: "tools/llm", to: "azure/openai", since: "2026-06-15" }],
  });
  const { nodes, links } = loadWorld(tl.world);
  const layout = layoutWorld(
    tl.world.cities.map((c) => c.id),
    nodes,
    links,
    [],
    new Map(),
    new Set(),
    new Map(),
    new Set(["azure"]),
  );
  const keys = planShots(tl, layout);
  const arrival = tl.cities.get("azure")!.from;
  const service = tl.nodes.get("azure/openai")!.from;

  test("a cloud's arrival is framed at its altitude, apart from the island's work", () => {
    const shot = keys.findLast((k) => k.t <= arrival)!;
    const cloud = layout.cities.get("azure")!.center;
    expect(shot.lookAt[1]).toBeGreaterThan(CLOUD_ALTITUDE / 2);
    expect(Math.hypot(shot.lookAt[0] - cloud[0], shot.lookAt[2] - cloud[1])).toBeLessThan(15);
  });

  test("the shot holds while the cloud lands and its service rises", () => {
    const shot = keys.findLast((k) => k.t <= arrival)!;
    const next = keys[keys.indexOf(shot) + 1];
    expect(next?.t ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(service + tl.rampSec);
  });

  test("a cloud with no cable car is framed with the nearest island, never empty sea", () => {
    const lone = parseScenario({ ...tl.scenario, links: [] });
    const { nodes: n2, links: l2 } = loadWorld(lone.world);
    const bare = layoutWorld(
      lone.world.cities.map((c) => c.id),
      n2,
      l2,
      [],
      new Map(),
      new Set(),
      new Map(),
      new Set(["azure"]),
    );
    expect(bare.cableways).toHaveLength(0);
    const shot = planShots(lone, bare).findLast((k) => k.t <= lone.cities.get("azure")!.from)!;
    const cloud = bare.cities.get("azure")!.center;
    const island = bare.cities.get("tools")!.center;
    // The look-at sits between the two and the shot is wide enough for both.
    const toCloud = Math.hypot(shot.lookAt[0] - cloud[0], shot.lookAt[2] - cloud[1]);
    const toIsland = Math.hypot(shot.lookAt[0] - island[0], shot.lookAt[2] - island[1]);
    expect(Math.abs(toCloud - toIsland)).toBeLessThan(
      Math.hypot(cloud[0] - island[0], cloud[1] - island[1]) / 2,
    );
    expect(shot.distance).toBeGreaterThan(keys.findLast((k) => k.t <= arrival)!.distance);
  });

  test("a chapter opening on a cloud lands on it at altitude", () => {
    const chaptered = parseScenario({
      ...tl.scenario,
      chapters: [{ at: "2026-06-01", title: "Azure" }],
    });
    const ch = chaptered.chapters[0]!;
    const shots = planShots(chaptered, layout);
    const shot = shots.find((k) => k.t + k.duration >= ch.at - 1e-9)!;
    expect(shot.t + shot.duration).toBeLessThanOrEqual(ch.at + ch.holdSec + 1e-9);
    expect(shot.lookAt[1]).toBeGreaterThan(CLOUD_ALTITUDE / 2);
  });
});

/** Seconds each move lands at, and the hold that follows before the next one starts. */
function holds(keys: ShotKey[]) {
  return keys.slice(0, -1).map((k, i) => keys[i + 1]!.t - (k.t + k.duration));
}

/** Largest heading change (deg) over any `window` seconds. */
function maxTurn(keys: ShotKey[], totalSec: number, window: number) {
  const step = 1 / 30;
  const heading: number[] = [];
  let unwrapped = 0;
  let prev: number | null = null;
  for (let t = 0; t < totalSec; t += step) {
    const { position, lookAt } = shotAt(keys, t)!;
    const a = (Math.atan2(position[0] - lookAt[0], position[2] - lookAt[2]) * 180) / Math.PI;
    if (prev !== null) {
      unwrapped += ((((a - prev + 540) % 360) + 360) % 360) - 180;
    }
    prev = a;
    heading.push(unwrapped);
  }
  const span = Math.round(window / step);
  let max = 0;
  for (let i = span; i < heading.length; i++) {
    max = Math.max(max, Math.abs(heading[i]! - heading[i - span]!));
  }
  return max;
}

describe("director, chapters", () => {
  const withChapters = (chapters: { at: string; title: string }[]) => {
    const tl = parseScenario({ ...example, chapters });
    const { nodes, links } = loadWorld(tl.world);
    const layout = layoutWorld(
      tl.world.cities.map((c) => c.id),
      nodes,
      links,
    );
    return { tl, layout, keys: planShots(tl, layout) };
  };
  const { tl, keys } = withChapters([
    { at: "2026-03-01", title: "Cache" },
    { at: "2026-04-20", title: "Queue" },
    { at: "2026-07-01", title: "Legacy out" },
    { at: "2026-08-01", title: "London" },
    { at: "2026-10-15", title: "Dashboard" },
  ]);
  const landings = keys.map((k) => k.t + k.duration);

  test("one move per chapter, landing on its title card", () => {
    for (const ch of tl.chapters) {
      const inside = landings.filter((l) => l >= ch.at - 1e-9 && l < ch.to);
      expect(inside.length).toBe(1);
      expect(inside[0]!).toBeLessThanOrEqual(ch.at + ch.holdSec + 1e-9);
    }
    // Intro, one per chapter, outro.
    expect(keys.length).toBe(tl.chapters.length + 2);
  });

  test("no move starts during a chapter's rises", () => {
    for (const ch of tl.chapters) {
      for (const k of keys) {
        expect(k.t >= ch.at + ch.holdSec && k.t < ch.to - MAX_MOVE).toBe(false);
      }
    }
  });

  test(`every framing holds at least ${MIN_HOLD} s`, () => {
    for (const h of holds(keys).slice(1)) {
      expect(h).toBeGreaterThanOrEqual(MIN_HOLD - 1e-9);
    }
  });

  test("the camera moves less than a quarter of the time", () => {
    const moving = keys.slice(1).reduce((s, k) => s + k.duration, 0);
    expect(moving / tl.totalSec).toBeLessThan(0.25);
  });

  test("holds orbit slowly, never more than 15° in 10 s", () => {
    expect(maxTurn(keys, tl.totalSec, 10)).toBeLessThanOrEqual(15);
    expect(maxTurn(keys, tl.totalSec, 10)).toBeGreaterThan(5);
    expect(ORBIT_DEG_PER_SEC).toBeLessThanOrEqual(1.5);
  });

  test("the pose is continuous with chapters", () => {
    let prev = shotAt(keys, 0)!;
    for (let t = 1 / 60; t < tl.totalSec; t += 1 / 60) {
      const pose = shotAt(keys, t)!;
      expect(
        Math.hypot(
          pose.position[0] - prev.position[0],
          pose.position[1] - prev.position[1],
          pose.position[2] - prev.position[2],
        ),
      ).toBeLessThan(2);
      prev = pose;
    }
  });

  test("a migration chapter frames the rises and the demolition together", () => {
    const m = withChapters([
      { at: "2026-03-01", title: "Cache" },
      { at: "2026-07-01", title: "Migration" },
    ]);
    const ch = m.tl.chapters[1]!;
    const shot = m.keys.find((k) => k.t + k.duration >= ch.at - 1e-9)!;
    expect(m.keys.filter((k) => k.t > shot.t && k.t < ch.to - MAX_MOVE)).toEqual([]);
    const legacy = m.layout.nodes.find((n) => n.id === "legacy-db")!.position;
    const london = m.layout.cities.get("london-1")!.center;
    for (const [x, z] of [
      [legacy[0], legacy[2]],
      [london[0], london[1]],
    ] as const) {
      expect(Math.hypot(shot.lookAt[0] - x, shot.lookAt[2] - z)).toBeLessThan(shot.distance);
    }
  });
});

describe("director, minimum hold without chapters", () => {
  test(`legacy shots hold at least ${MIN_HOLD} s too`, () => {
    const tl = parseScenario(example);
    const { nodes, links } = loadWorld(tl.world);
    const keys = planShots(
      tl,
      layoutWorld(
        tl.world.cities.map((c) => c.id),
        nodes,
        links,
      ),
    );
    for (const h of holds(keys).slice(1)) {
      expect(h).toBeGreaterThanOrEqual(MIN_HOLD - 1e-9);
    }
    expect(maxTurn(keys, tl.totalSec, 10)).toBeLessThanOrEqual(15);
  });
});
