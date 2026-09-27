import { describe, expect, test } from "bun:test";
import { darken, hexToHsl, hslToHex, shiftHsl } from "@/domain/color";

describe("color", () => {
  test("hex → hsl → hex round-trips", () => {
    for (const hex of [
      "#4488ff",
      "#44bb66",
      "#ff8844",
      "#aa44ff",
      "#1a1a2e",
      "#000000",
      "#ffffff",
    ]) {
      const [h, s, l] = hexToHsl(hex);
      expect(hslToHex(h, s, l)).toBe(hex);
    }
  });

  test("shiftHsl with zero deltas is the identity", () => {
    expect(shiftHsl("#4488ff", 0, 0, 0)).toBe("#4488ff");
  });

  test("shiftHsl rotates the hue and clamps saturation / lightness", () => {
    const [h0] = hexToHsl("#4488ff");
    const [h1] = hexToHsl(shiftHsl("#4488ff", 30, 0, 0));
    expect((((h1 - h0) % 360) + 360) % 360).toBeCloseTo(30, 0);
    expect(shiftHsl("#4488ff", 0, 5, 5)).toBe("#ffffff");
  });

  test("darken scales towards black", () => {
    expect(darken("#4488ff", 0)).toBe("#4488ff");
    expect(darken("#4488ff", 1)).toBe("#000000");
    expect(darken("#4488ff", 0.5)).toBe("#224480");
  });
});
