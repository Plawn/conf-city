import { describe, expect, test } from "bun:test";
import { activeKey, parseScenario, presenceAt } from "@/domain/scenario";
import { assembleWorld, layoutWorld, planWorld } from "@/layout/layoutWorld";
import { linkKey } from "@/layout/types";
import { loadWorld } from "@/loaders/loadWorld";
import example from "../../public/scenarios/example.json";

describe("pinned layout", () => {
  const tl = parseScenario(example);
  const { nodes, links } = loadWorld(tl.world);
  const ids = tl.world.cities.map((c) => c.id);
  const plan = planWorld(ids, nodes, links);
  const full = assembleWorld(plan);
  const plots = new Map([...full.cities].map(([id, c]) => [id, c.utilityPlot]));
  const at = (t: number) => {
    const p = presenceAt(tl, t);
    return assembleWorld(plan, {
      cities: new Set(p.cities.keys()),
      nodes: new Set(p.nodes.keys()),
      links: new Set(p.links.keys()),
      plots,
    });
  };

  test("the full assembly is the live layout", () => {
    expect(JSON.stringify(full.nodes)).toBe(JSON.stringify(layoutWorld(ids, nodes, links).nodes));
  });

  test("a building stands exactly where the union put it, at every instant", () => {
    const where = new Map(full.nodes.map((n) => [`${n.cityId}/${n.id}`, n.position]));
    for (let t = 0; t < tl.totalSec; t += 2) {
      for (const n of at(t).nodes) {
        expect(n.position).toEqual(where.get(`${n.cityId}/${n.id}`)!);
      }
    }
  });

  test("streets and bridges only carry live links", () => {
    for (let t = 0; t < tl.totalSec; t += 2) {
      const live = new Set(presenceAt(tl, t).links.keys());
      const world = at(t);
      for (const city of world.cities.values()) {
        for (const key of city.roads.routes.keys()) {
          if (!key.startsWith("ring:")) {
            expect(live.has(key)).toBe(true);
          }
        }
      }
      for (const b of world.bridges) {
        for (const c of b.crossings) {
          expect(live.has(linkKey(c.link))).toBe(true);
        }
      }
    }
  });

  test("the lighthouse never moves and the plan survives repeated assembly", () => {
    const early = at(5);
    expect(early.cities.has("london-1")).toBe(false);
    expect(early.cities.get("paris-1")!.utilityPlot).toEqual(
      full.cities.get("paris-1")!.utilityPlot!,
    );
    const again = assembleWorld(plan);
    expect(JSON.stringify([...again.cities.values()].map((c) => c.roads.ring))).toBe(
      JSON.stringify([...full.cities.values()].map((c) => c.roads.ring)),
    );
    expect(activeKey(presenceAt(tl, 5))).not.toBe(activeKey(presenceAt(tl, 40)));
  });
});
