import { describe, expect, test } from "bun:test";
import { planShots, shotAt, TRANSITION } from "@/domain/director";
import { parseScenario } from "@/domain/scenario";
import { CLOUD_ALTITUDE } from "@/layout/cloud";
import { layoutWorld } from "@/layout/layoutWorld";
import { loadWorld } from "@/loaders/loadWorld";
import example from "../../public/scenarios/example.json";

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
      expect(keys[i]!.t - keys[i - 1]!.t).toBeGreaterThanOrEqual(TRANSITION - 1e-9);
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
});
