import { describe, expect, test } from "bun:test";
import { vecKey } from "@/layout/geometry";
import { layoutWorld } from "@/layout/layoutWorld";
import { city, grid, interLink, intraLinks } from "../fixtures/layout";

describe("layoutWorld", () => {
  test("bridgeheads are ring vertices and roundabout centres of their city, exactly", () => {
    const nodes = [...grid("a", 3, 2), ...grid("b", 2, 2)];
    const links = [
      ...intraLinks("a", [["n00", "n21"]]),
      ...intraLinks("b", [["n00", "n11"]]),
      interLink(["a", "n10"], ["b", "n01"]),
      interLink(["a", "n21"], ["b", "n11"]),
    ];
    const world = layoutWorld(["a", "b"], nodes, links);
    expect(world.bridges).toHaveLength(1);
    const bridge = world.bridges[0]!;
    const [headA, headB] = bridge.waterSpan;
    const a = world.cities.get("a")!.roads;
    const b = world.cities.get("b")!.roads;
    expect(a.ring.map(vecKey)).toContain(vecKey(headA));
    expect(b.ring.map(vecKey)).toContain(vecKey(headB));
    expect(a.roundabouts.map((r) => vecKey(r.center))).toContain(vecKey(headA));
    expect(b.roundabouts.map((r) => vecKey(r.center))).toContain(vecKey(headB));
    expect(bridge.crossings).toHaveLength(2);
    // Every feeder route ends on its bridgehead.
    for (const c of bridge.crossings) {
      const ra = a.routes.get(c.key);
      const rb = b.routes.get(c.key);
      expect(ra).toBeDefined();
      expect(rb).toBeDefined();
      expect(vecKey(ra!.points[ra!.points.length - 1]!)).toBe(vecKey(headA));
      expect(vecKey(rb!.points[rb!.points.length - 1]!)).toBe(vecKey(headB));
    }
  });

  test("a lone building on each shore still gets a bridge, by its own driveway", () => {
    const nodes = [...city("x", ["one"]), ...city("y", ["two"])];
    const world = layoutWorld(["x", "y"], nodes, [interLink(["x", "one"], ["y", "two"])]);
    expect(world.bridges).toHaveLength(1);
    const [hx, hy] = world.bridges[0]!.waterSpan;
    const x = world.cities.get("x")!.roads;
    const y = world.cities.get("y")!.roads;
    expect(x.ring.map(vecKey)).toContain(vecKey(hx));
    expect(y.ring.map(vecKey)).toContain(vecKey(hy));
    expect(x.driveways.some((d) => vecKey(d.mouth) === vecKey(hx))).toBe(true);
    expect(y.driveways.some((d) => vecKey(d.mouth) === vecKey(hy))).toBe(true);
    expect(x.routes.has("ring:one")).toBe(false);
  });

  test("the layout is deterministic", () => {
    const nodes = [...grid("a", 3, 3), ...grid("b", 2, 2)];
    const links = [
      ...intraLinks("a", [
        ["n00", "n22"],
        ["n20", "n02"],
      ]),
      interLink(["a", "n11"], ["b", "n00"]),
    ];
    const w1 = layoutWorld(["a", "b"], nodes, links);
    const w2 = layoutWorld(["a", "b"], nodes, links);
    expect(JSON.stringify(w1.nodes)).toBe(JSON.stringify(w2.nodes));
    expect(JSON.stringify([...w1.cities.values()].map((c) => c.roads.segments))).toBe(
      JSON.stringify([...w2.cities.values()].map((c) => c.roads.segments)),
    );
  });
});
