import * as THREE from "three";
import type { BuildingVariant } from "../../domain/buildingVariant";
import { ERROR_RATE_THRESHOLD } from "../../domain/incidents";
import { heatColor } from "../../domain/metrics/format";
import { LIVENESS_COLORS } from "../../domain/nodeStyle";
import type { NodeTelemetry, NodeType } from "../../domain/types";
import type { ViewMode } from "../../domain/viewMode";

export interface MaterialVisual {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
}
/** Visual targets derived from props; read inside useFrame through a ref. */
export interface VisualState {
  liveness?: NodeTelemetry["liveness"];
  /** CPU saturation vs allocated cores, 0..1+ */
  cpuSat: number;
  errorRate: number;
  rps: number;
  /** log-normalised memory 0..1 within the city (undefined → fall back to rps) */
  memNorm?: number;
  /** heat 0..1 for the active heatmap mode (undefined in health mode / no data) */
  heat?: number;
  mode: ViewMode;
  hovered: boolean;
  selected: boolean;
}

export const DAMP = 6;
const HEAT_BASE = "#6f7488"; // grey buildings in heatmap modes
const HEAT_NONE = "#3a3d4a"; // no data for the selected metric
/** Below this the lerp has visually arrived; keep going and every building pays a colour write forever. */
export const SETTLED = 1 / 512;

/**
 * `Color.set(string)` parses the hex — cheap once, but it ran twice per building
 * per frame, on a palette of a dozen values. Resolve each string once, for good.
 */
const COLOR_CACHE = new Map<string, THREE.Color>();
export function color(hex: string): THREE.Color {
  let c = COLOR_CACHE.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    COLOR_CACHE.set(hex, c);
  }
  return c;
}

/**
 * How far a tint is pulled toward white before it is applied to a textured model.
 * (`PORT_TINT` below is the same idea, pushed further, for the quay.)
 *
 * The Kenney kits ship one `colormap` atlas per building: windows, doors, roof
 * trim, a darker plinth. `MeshStandardMaterial.color` *multiplies* it, so painting
 * a skyscraper with the full `#4488ff` collapsed all of that into one flat blue
 * block — the texture was there, it was just being multiplied out of existence
 * (and before this it was not even copied off the loaded material). Blending the
 * tint most of the way to white keeps the type and biome hue readable while the
 * atlas still shows through.
 */
export const MAP_TINT = 0.6;
/**
 * The port keeps its own colours almost untouched.
 *
 * A quay is not a service-coloured box: cranes, containers and the transit shed
 * carry the meaning, and multiplying the whole model by the type hue turned it
 * into one flat blue mass on the shore. The tint is pulled nearly to white so it
 * only breathes over the model — the liveness and error colours still read,
 * because those come through the emissive, not this multiply.
 */
export const PORT_TINT = 0.82;
const WHITE = new THREE.Color("#ffffff");
const TINT_CACHE = new Map<string, THREE.Color>();
/** `hex` blended `fade` of the way to white; 0 returns the colour itself. */
export function mapTinted(hex: string, fade = MAP_TINT): THREE.Color {
  const key = `${hex}|${fade}`;
  let c = TINT_CACHE.get(key);
  if (!c) {
    c = new THREE.Color(hex).lerp(WHITE, fade);
    TINT_CACHE.set(key, c);
  }
  return c;
}

/** True once both colours and the intensity sit within `SETTLED` of their target. */
export function settled(
  m: MaterialVisual,
  base: THREE.Color,
  emissive: THREE.Color,
  intensity: number,
): boolean {
  return (
    Math.abs(m.emissiveIntensity - intensity) < SETTLED &&
    Math.abs(m.color.r - base.r) < SETTLED &&
    Math.abs(m.color.g - base.g) < SETTLED &&
    Math.abs(m.color.b - base.b) < SETTLED &&
    Math.abs(m.emissive.r - emissive.r) < SETTLED &&
    Math.abs(m.emissive.g - emissive.g) < SETTLED &&
    Math.abs(m.emissive.b - emissive.b) < SETTLED
  );
}

export function visualTarget(
  v: VisualState,
  variant: BuildingVariant,
  fade: number,
  night: number,
  time: number,
) {
  // Health mode starts from the variant's tinted type colour; the heatmap
  // branches below overwrite it, so a biome never leaks into a heat read.
  let base = variant.color;
  let emissive = variant.emissive;
  let intensity = 0.06 + night * 0.12;

  if (v.mode !== "health") {
    // Heatmap: grey buildings, the selected metric glows green → orange → red
    if (v.heat == null) {
      base = HEAT_NONE;
      emissive = HEAT_NONE;
      intensity = 0.05;
    } else {
      const c = heatColor(v.heat);
      base = HEAT_BASE;
      emissive = c;
      intensity = 0.35 + Math.min(v.heat, 1) * 1.1;
    }
    if (v.liveness === "down") {
      intensity = 0.05;
    }
  } else if (v.liveness) {
    if (v.liveness !== "healthy") {
      base = LIVENESS_COLORS[v.liveness];
      emissive = LIVENESS_COLORS[v.liveness];
    }
    // CPU saturation adds emissive heat above the day/night readability floor.
    intensity = 0.06 + night * 0.12 + Math.min(v.cpuSat, 1.2) * 0.9;
    if (v.errorRate > ERROR_RATE_THRESHOLD) {
      emissive = "#ff3333";
      intensity = 0.9 + 0.6 * (0.5 + 0.5 * Math.sin(time * 6));
    }
    if (v.liveness === "down") {
      intensity = 0.1;
    }
  }
  if (v.selected) {
    emissive = "#9dc0ff";
    intensity = Math.max(intensity, 0.45);
  } else if (v.hovered) {
    emissive = "#cfd8ff";
    intensity = Math.max(intensity, 0.4);
  }

  return {
    color: fade > 0 ? mapTinted(base, fade) : color(base),
    emissive: color(emissive),
    intensity,
  };
}

/** Shared by individual materials and instance attributes, with identical damping. */
export class MaterialAnimation {
  private target: ReturnType<typeof visualTarget> | null = null;
  private visual: VisualState | null = null;
  private night = Number.NaN;
  constructor(
    private variant: BuildingVariant,
    private fade: number,
  ) {}
  advance(
    materials: MaterialVisual[],
    visual: VisualState,
    night: number,
    time: number,
    delta: number,
  ) {
    const pulse =
      visual.mode === "health" &&
      !!visual.liveness &&
      visual.liveness !== "down" &&
      visual.errorRate > ERROR_RATE_THRESHOLD;
    if (this.visual !== visual || this.night !== night || pulse || !this.target) {
      this.target = visualTarget(visual, this.variant, this.fade, night, time);
      this.visual = visual;
      this.night = night;
    }
    const target = this.target;
    const first = materials[0];
    const changed = !!first && !settled(first, target.color, target.emissive, target.intensity);
    if (changed) {
      const k = 1 - Math.exp(-DAMP * delta);
      for (const m of materials) {
        m.color.lerp(target.color, k);
        m.emissive.lerp(target.emissive, k);
        m.emissiveIntensity += (target.intensity - m.emissiveIntensity) * k;
      }
    }
    return { changed, active: changed || pulse };
  }
}

export function heightTarget(type: NodeType, visual: VisualState) {
  const y =
    visual.memNorm != null
      ? 0.7 + visual.memNorm
      : 1 + Math.min(Math.max(visual.rps / 200, 0), 0.6);
  return type === "app" ? y : THREE.MathUtils.clamp(y, 0.85, 1.15);
}
