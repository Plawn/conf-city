/**
 * Hex ↔ HSL helpers, pure and Three-free: the biome tints and the per-building
 * colour jitter are decided in the domain and handed to the renderer as hex.
 */

export type Rgb = [number, number, number];
export type Hsl = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const to = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** `[hue 0..360, saturation 0..1, lightness 0..1]`. */
export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) {
    return [0, 0, l];
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }
  return [h, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const lig = clamp01(l);
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let rgb: Rgb;
  if (hue < 60) {
    rgb = [c, x, 0];
  } else if (hue < 120) {
    rgb = [x, c, 0];
  } else if (hue < 180) {
    rgb = [0, c, x];
  } else if (hue < 240) {
    rgb = [0, x, c];
  } else if (hue < 300) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }
  return rgbToHex([rgb[0] + m, rgb[1] + m, rgb[2] + m]);
}

/** Rotates the hue by `dh` degrees and nudges saturation / lightness by `ds` / `dl`. */
export function shiftHsl(hex: string, dh: number, ds: number, dl: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + dh, s + ds, l + dl);
}

/** Scales the colour towards black: `k = 0` leaves it alone, `k = 1` is black. */
export function darken(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 - clamp01(k);
  return rgbToHex([r * f, g * f, b * f]);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
