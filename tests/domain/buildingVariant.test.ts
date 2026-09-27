import { describe, expect, test } from "bun:test";
import { BIOMES } from "@/domain/biome";
import { buildingVariant } from "@/domain/buildingVariant";
import { hexToHsl } from "@/domain/color";
import { NODE_STYLE } from "@/domain/nodeStyle";
import type { NodeType } from "@/domain/types";

const TYPES: NodeType[] = ["app", "db", "cache", "queue"];

describe("buildingVariant", () => {
  test("is deterministic per address", () => {
    const a = buildingVariant("prod/api", "app", BIOMES.meadow);
    const b = buildingVariant("prod/api", "app", BIOMES.meadow);
    expect(a).toEqual(b);
  });

  test("rotates by quarter turns and scales within bounds", () => {
    for (let i = 0; i < 100; i++) {
      for (const type of TYPES) {
        const v = buildingVariant(`city/n${i}`, type, BIOMES.harbour);
        const k = v.yaw / (Math.PI / 2);
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(4);
        expect(v.scale).toBeGreaterThanOrEqual(0.92);
        expect(v.scale).toBeLessThanOrEqual(1.08);
      }
    }
  });

  test("keeps the type's hue within the biome tint ± 8°", () => {
    for (const type of TYPES) {
      const [h0] = hexToHsl(NODE_STYLE[type].color);
      for (let i = 0; i < 50; i++) {
        const [h1] = hexToHsl(buildingVariant(`c/${type}${i}`, type, BIOMES.dunes).color);
        const delta = ((h1 - h0 - BIOMES.dunes.tint.hue + 540) % 360) - 180;
        expect(Math.abs(delta)).toBeLessThanOrEqual(8.5);
      }
    }
  });

  test("the harbour biome leaves the type colour recognisable", () => {
    const v = buildingVariant("c/x", "app", BIOMES.harbour);
    const [, s0, l0] = hexToHsl(NODE_STYLE.app.color);
    const [, s1, l1] = hexToHsl(v.color);
    expect(Math.abs(s1 - s0)).toBeLessThan(0.02);
    expect(Math.abs(l1 - l0)).toBeLessThanOrEqual(0.051);
  });

  test("actually varies between neighbours", () => {
    const colors = new Set<string>();
    const yaws = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const v = buildingVariant(`c/app-${i}`, "app", BIOMES.meadow);
      colors.add(v.color);
      yaws.add(v.yaw);
    }
    expect(colors.size).toBeGreaterThan(10);
    expect(yaws.size).toBe(4);
  });

  test("only ever picks a model the type declares; an empty availability falls back to the first", () => {
    for (const type of TYPES) {
      const paths = new Set(NODE_STYLE[type].models.map((m) => m.path));
      for (let i = 0; i < 20; i++) {
        expect(paths.has(buildingVariant(`c/${i}`, type, BIOMES.basalt).model)).toBe(true);
      }
      const v = buildingVariant("c/none", type, BIOMES.basalt, new Set());
      expect(v.model).toBe(NODE_STYLE[type].models[0]!.path);
      expect(v.model).toBe(NODE_STYLE[type].modelPath);
    }
  });
});
