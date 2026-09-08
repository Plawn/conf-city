import { expect, test } from "bun:test";
import { NODE_STYLE } from "../../domain/nodeStyle";
import { footprintRadius } from "../../layout/constants";
import { type IndustrialStyle, industrialGeometry } from "./industrialGeometry";

test("industrial buildings fit existing plots even at maximum variant scale and rotated", () => {
  const styles: [IndustrialStyle, "db" | "cache" | "queue"][] = [
    ["warehouse", "db"],
    ["sheds", "db"],
    ["datacenter", "db"],
    ["depot", "cache"],
    ["cold-storage", "cache"],
    ["terminal", "queue"],
    ["containers", "queue"],
  ];
  for (const [style, type] of styles) {
    const g = industrialGeometry(style);
    const position = g.getAttribute("position");
    let radius = 0;
    for (let i = 0; i < position.count; i++) {
      radius = Math.max(radius, Math.hypot(position.getX(i), position.getZ(i)));
    }
    expect(radius * NODE_STYLE[type].scale * 1.08).toBeLessThanOrEqual(footprintRadius(type));
    expect(g.boundingBox!.min.y).toBeCloseTo(0);
    expect(g.boundingBox!.max.y * 1.15).toBeLessThan(1);
    expect(g.getAttribute("color").count).toBe(position.count);
    g.dispose();
  }
});
