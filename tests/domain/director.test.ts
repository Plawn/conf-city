import { describe, expect, test } from "bun:test";
import { planShots, shotAt, TRANSITION } from "@/domain/director";
import { parseScenario } from "@/domain/scenario";
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
