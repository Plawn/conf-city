/** Decides when the sun shadow map re-renders; the tier's `shadowHz` is a ceiling. */
export type ShadowRefreshReason = "settings" | "sun" | "bounds" | "buildings" | "view";

export interface ShadowRefreshInput {
  /** Seconds, monotonic. */
  time: number;
  /** Lighting settings revision changed (clock scrub, location, live/preview). */
  settingsChanged: boolean;
  /** Unit vector towards the sun. */
  sunDirection: { x: number; y: number; z: number };
  sunIntensity: number;
  /** World units covered by one shadow texel at the current fit. */
  worldTexel: number;
  /** The caster/receiver bounds gained, lost or moved an entry. */
  boundsMutated: boolean;
  /** Building instance matrices written during the previous frame. */
  buildingWrites: number;
  /** The framed view region left the previous map's margin. */
  viewMoved: boolean;
}

/** Height of the reference pole whose shadow tip tracks the sun's motion. */
const POLE_HEIGHT = 12;
/** Below this elevation the pole shadow is treated as horizontal-ish, not infinite. */
const MIN_ELEVATION = 0.05;

const ORDER: readonly ShadowRefreshReason[] = ["settings", "view", "bounds", "buildings", "sun"];

export class ShadowRefreshPolicy {
  private nextAllowed = Number.NEGATIVE_INFINITY;
  private pending = new Set<ShadowRefreshReason>();
  private poleX = Number.NaN;
  private poleZ = Number.NaN;
  private interval: number;

  constructor(hz: number) {
    this.interval = 1 / Math.max(0.001, hz);
  }

  setHz(hz: number) {
    this.interval = 1 / Math.max(0.001, hz);
  }

  /** Forget the last rendered state, e.g. when the map size changed. */
  invalidate() {
    this.pending.add("settings");
    this.nextAllowed = Number.NEGATIVE_INFINITY;
  }

  /** Reason to render now, or null; reasons seen during the throttle stay pending. */
  decide(input: ShadowRefreshInput): ShadowRefreshReason | null {
    if (input.settingsChanged) {
      this.pending.add("settings");
      this.nextAllowed = Number.NEGATIVE_INFINITY;
    }
    if (input.viewMoved) {
      this.pending.add("view");
    }
    if (input.boundsMutated) {
      this.pending.add("bounds");
    }
    if (input.buildingWrites > 0) {
      this.pending.add("buildings");
    }
    const elevation = Math.max(MIN_ELEVATION, input.sunDirection.y);
    const poleX = (-input.sunDirection.x / elevation) * POLE_HEIGHT;
    const poleZ = (-input.sunDirection.z / elevation) * POLE_HEIGHT;
    if (
      Number.isNaN(this.poleX) ||
      Math.hypot(poleX - this.poleX, poleZ - this.poleZ) > Math.max(1e-6, input.worldTexel)
    ) {
      this.pending.add("sun");
    }
    if (input.sunIntensity <= 0 || this.pending.size === 0 || input.time < this.nextAllowed) {
      return null;
    }
    const reason = ORDER.find((candidate) => this.pending.has(candidate)) ?? null;
    this.pending.clear();
    this.nextAllowed = input.time + this.interval;
    this.poleX = poleX;
    this.poleZ = poleZ;
    return reason;
  }
}
