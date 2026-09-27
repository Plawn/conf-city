import { fnv1a, mulberry32 } from "../lib/random";
import type { Biome } from "./biome";
import { darken, shiftHsl } from "./color";
import { NODE_STYLE } from "./nodeStyle";
import type { NodeType } from "./types";

/**
 * What makes two buildings of the same type look like two buildings: a model
 * picked among the type's variants, a quarter-turn, a touch of scale, and a
 * colour nudged around the type's hue by the island's biome. Everything is
 * seeded on the node address, so a building keeps its face across reloads,
 * re-layouts and telemetry ticks.
 *
 * Render-only: `scale` never reaches the layout, whose footprints come from
 * `NODE_STYLE[type].scale` alone — and the gauge / selection rings keep that
 * scale too, so they stay identical across variants.
 */
export interface BuildingVariant {
  /** GLB path — one of `NODE_STYLE[type].models`. */
  model: string;
  /** Scale factor that brings this model to the type's reference height. */
  fit: number;
  /** Rotation around Y, a multiple of π/2 so the door still faces a street. */
  yaw: number;
  /** Extra scale, 0.92..1.08. */
  scale: number;
  /** Base colour in health mode: the type's hue tinted by the biome, ±8°, ±5 % lightness. */
  color: string;
  /** `darken(color, 0.5)` — the ratio the type palette already uses (`#4488ff` → `#2244aa`). */
  emissive: string;
}

const HUE_JITTER = 16;
const LIGHT_JITTER = 0.1;
const SCALE_MIN = 0.92;
const SCALE_MAX = 1.08;

/**
 * Draws are made in a fixed order (model, yaw, scale, hue, light) so adding a
 * model to a type reshuffles nothing but the model choice.
 *
 * `available`, when given, restricts the models to those paths — anything not
 * in it falls back to the type's first model, which always ships.
 */
export function buildingVariant(
  addr: string,
  type: NodeType,
  biome: Biome,
  available?: ReadonlySet<string>,
): BuildingVariant {
  const style = NODE_STYLE[type];
  const candidates = available ? style.models.filter((m) => available.has(m.path)) : style.models;
  const models = candidates.length > 0 ? candidates : style.models.slice(0, 1);
  const rand = mulberry32(fnv1a(addr));

  const model = models[Math.min(models.length - 1, Math.floor(rand() * models.length))]!;
  const yaw = Math.floor(rand() * 4) * (Math.PI / 2);
  const scale = SCALE_MIN + rand() * (SCALE_MAX - SCALE_MIN);
  const hue = (rand() - 0.5) * HUE_JITTER;
  const light = (rand() - 0.5) * LIGHT_JITTER;

  const color = shiftHsl(
    style.color,
    biome.tint.hue + hue,
    biome.tint.sat,
    biome.tint.light + light,
  );
  return { model: model.path, fit: model.fit, yaw, scale, color, emissive: darken(color, 0.5) };
}
