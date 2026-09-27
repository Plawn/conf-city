import { describe, expect, test } from "bun:test";
import type { PositionedNode } from "@/domain/types";
import { layoutCity } from "@/layout/layoutCity";
import { buildRoadNetwork } from "@/layout/roads/network";
import { linkKey } from "@/layout/types";
import { grid, intraLinks } from "../fixtures/layout";

const span = (nodes: PositionedNode[]) => {
  const xs = nodes.map((n) => n.position[0]);
  const zs = nodes.map((n) => n.position[2]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
};

describe("layoutCity dense", () => {
  const nodes = grid("a", 5, 4);
  const links = intraLinks("a", [
    ["n00", "n11"],
    ["n11", "n22"],
    ["n30", "n43"],
  ]);

  test("packs the same buildings on less land, one per cell", () => {
    const loose = layoutCity("a", nodes, [], links);
    const dense = layoutCity("a", nodes, [], links, new Set(), true);
    expect(span(dense.nodes)).toBeLessThan(span(loose.nodes));
    const cells = new Set([...dense.cells.values()].map((c) => `${c[0]},${c[1]}`));
    expect(cells.size).toBe(nodes.length);
  });

  test("still routes every link", () => {
    const dense = layoutCity("a", nodes, [], links, new Set(), true);
    const roads = buildRoadNetwork(dense, links);
    for (const l of links) {
      expect(roads.routes.get(linkKey(l))).toBeDefined();
    }
  });
});
