import { percentile } from "../lib/stats";
/**
 * Rendering quality tiers. Every per-frame budget the renderer scales with the
 * machine — pixels, contact shading, shadows, local lights, traffic — comes from
 * one of these profiles rather than from constants scattered across components.
 *
 * `high` is the reference look; `balanced` keeps every effect at a lower cost;
 * `eco` trades effects for frame time on integrated GPUs and software adapters.
 */
export type QualityTier = "eco" | "balanced" | "high";
export type QualityChoice = QualityTier | "auto";

export const QUALITY_TIERS: readonly QualityTier[] = ["eco", "balanced", "high"];

export interface QualityProfile {
  tier: QualityTier;
  /** Cap on rendered pixels (canvas size × render scale). */
  maxPixels: number;
  /** Cap on the render scale relative to CSS pixels. */
  maxDpr: number;
  ao: { enabled: boolean; samples: number; denoise: boolean };
  /** Bloom mip chain resolution relative to the frame. */
  bloomScale: number;
  /** Sun shadow map edge, in texels. */
  shadowMapSize: number;
  /** Sun shadow refit/render cadence, per second. */
  shadowHz: number;
  /** Whether the selected lighthouse spotlight renders its own shadow map. */
  beaconShadow: boolean;
  /** Raymarched lighthouse volume; the cone overlay stands in otherwise. */
  volume: boolean;
  /** Clustered point-light budget (WebGPU). */
  pointLights: number;
  /** Vehicle headlight spotlights evaluated per fragment (WebGPU). */
  vehicleSpots: number;
  maxCars: number;
  maxTrucks: number;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  eco: {
    tier: "eco",
    maxPixels: 1_200_000,
    maxDpr: 1,
    ao: { enabled: false, samples: 0, denoise: false },
    bloomScale: 0.25,
    shadowMapSize: 1024,
    shadowHz: 4,
    beaconShadow: false,
    volume: false,
    pointLights: 96,
    vehicleSpots: 4,
    maxCars: 120,
    maxTrucks: 30,
  },
  balanced: {
    tier: "balanced",
    maxPixels: 2_400_000,
    maxDpr: 1.5,
    ao: { enabled: true, samples: 8, denoise: true },
    bloomScale: 0.5,
    shadowMapSize: 2048,
    shadowHz: 6,
    beaconShadow: true,
    volume: true,
    pointLights: 256,
    vehicleSpots: 8,
    maxCars: 240,
    maxTrucks: 60,
  },
  high: {
    tier: "high",
    maxPixels: 5_000_000,
    maxDpr: 2,
    ao: { enabled: true, samples: 16, denoise: true },
    bloomScale: 0.5,
    shadowMapSize: 2048,
    shadowHz: 6,
    beaconShadow: true,
    volume: true,
    pointLights: 1024,
    vehicleSpots: 16,
    maxCars: 240,
    maxTrucks: 60,
  },
};

/** Texels of the clustered lights node, sized once: the widest tier's points plus a spot pair per vehicle slot. */
export const MAX_CLUSTERED_LIGHTS = Math.max(
  ...QUALITY_TIERS.map((tier) => {
    const profile = QUALITY_PROFILES[tier];
    return profile.pointLights + 2 * profile.vehicleSpots;
  }),
);

export const QUALITY_LABELS: Record<QualityChoice, string> = {
  auto: "Auto",
  eco: "Eco",
  balanced: "Balanced",
  high: "High",
};

export function isQualityTier(value: unknown): value is QualityTier {
  return value === "eco" || value === "balanced" || value === "high";
}

export function isQualityChoice(value: unknown): value is QualityChoice {
  return value === "auto" || isQualityTier(value);
}

const MIN_RENDER_SCALE = 0.5;
/** Quantum for the render scale: stable values avoid resizing on trivial layout jitter. */
const RENDER_SCALE_STEP = 0.05;

/**
 * Render scale for a canvas of `width × height` CSS pixels on a display of
 * `devicePixelRatio`, honouring the profile's pixel and ratio caps.
 */
export function resolveDpr(
  profile: Pick<QualityProfile, "maxPixels" | "maxDpr">,
  width: number,
  height: number,
  devicePixelRatio: number,
): number {
  const area = Math.max(1, width) * Math.max(1, height);
  const byPixels = Math.sqrt(profile.maxPixels / area);
  const raw = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, profile.maxDpr, byPixels);
  const stepped = Math.floor(raw / RENDER_SCALE_STEP + 1e-9) * RENDER_SCALE_STEP;
  return Math.max(MIN_RENDER_SCALE, Number(stepped.toFixed(2)));
}

export interface DeviceHints {
  backend: "webgpu" | "webgl";
  vendor: string;
  renderer: string;
  architecture: string;
  isFallbackAdapter: boolean | null;
  /** `navigator.hardwareConcurrency`, when known. */
  cores?: number;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
const DISCRETE =
  /nvidia|geforce|rtx|gtx|quadro|radeon (rx|pro|vii)|rdna|arc a\d|apple|metal|adreno 7|mali-g7|immortalis/i;
const INTEGRATED_INTEL = /intel|gen-?\d|xe-?lpg?|iris|uhd|hd graphics/i;

/**
 * Starting tier from what the adapter reports. Chrome's WebGPU adapter info is
 * often just a vendor and an architecture, so this only picks a sensible first
 * step; the governor corrects it from measured frames.
 */
export function initialTier(hints: DeviceHints): QualityTier {
  const text = `${hints.vendor} ${hints.renderer} ${hints.architecture}`;
  if (hints.isFallbackAdapter || SOFTWARE.test(text)) {
    return "eco";
  }
  const fewCores = hints.cores != null && hints.cores <= 4;
  if (INTEGRATED_INTEL.test(text)) {
    return hints.backend === "webgl" || fewCores ? "eco" : "balanced";
  }
  if (hints.backend === "webgl") {
    return "balanced";
  }
  if (DISCRETE.test(text)) {
    return fewCores ? "balanced" : "high";
  }
  return fewCores ? "eco" : "balanced";
}

export function stepTier(tier: QualityTier, delta: -1 | 1): QualityTier {
  const index = QUALITY_TIERS.indexOf(tier) + delta;
  return QUALITY_TIERS[Math.max(0, Math.min(QUALITY_TIERS.length - 1, index))]!;
}

export function compareTiers(a: QualityTier, b: QualityTier): number {
  return QUALITY_TIERS.indexOf(a) - QUALITY_TIERS.indexOf(b);
}

export interface GovernorOptions {
  /** Target frame interval, in milliseconds. */
  budgetMs: number;
  initial: QualityTier;
  /** Highest tier the governor may climb to; defaults to one step above `initial`. */
  ceiling?: QualityTier;
  now?: number;
}

export interface GovernorChange {
  at: number;
  from: QualityTier;
  to: QualityTier;
  p95Ms: number;
}

/** Frame intervals are judged over this sliding window. */
const WINDOW_MS = 3_000;
/** Frames over budget for this long step the quality down. */
const DOWN_HOLD_MS = 3_000;
/** Frames comfortably on cadence for this long step the quality up. */
const UP_HOLD_MS = 30_000;
/** Minimum time between two changes. */
const COOLDOWN_MS = 10_000;
/** Compilation and resizes follow a change; those frames are not evidence. */
const SETTLE_MS = 2_000;
/** A step down this soon after a step up means the probe failed: do not retry it. */
const PROBE_MS = 60_000;
/** Longer intervals are tab switches, GC pauses or debugger stops, not rendering cost. */
const MAX_FRAME_MS = 250;
const EVALUATE_EVERY_MS = 500;
const DOWN_RATIO = 1.25;
/** Frames on a capped clock never run faster than the cadence; "holding it" is the headroom signal. */
const UP_RATIO = 1.05;

/**
 * Steps the tier down quickly when frames miss the cadence, and back up slowly
 * once they hold it, with hysteresis so a scene that sits at the boundary does
 * not oscillate. Idle periods and outliers are excluded from the evidence.
 */
export function createGovernor(options: GovernorOptions) {
  let tier = options.initial;
  let ceiling = options.ceiling ?? stepTier(options.initial, 1);
  let budget = options.budgetMs;
  const start = options.now ?? 0;
  let lastChange = start - COOLDOWN_MS;
  let lastUp = Number.NEGATIVE_INFINITY;
  let underSince: number | null = null;
  let lastEvaluation = start;
  const times: number[] = [];
  const intervals: number[] = [];
  const changes: GovernorChange[] = [];

  const clear = () => {
    times.length = 0;
    intervals.length = 0;
    underSince = null;
  };
  const change = (now: number, to: QualityTier, p95Ms: number) => {
    changes.push({ at: now, from: tier, to, p95Ms });
    tier = to;
    lastChange = now;
    clear();
    return to;
  };

  return {
    get tier() {
      return tier;
    },
    get ceiling() {
      return ceiling;
    },
    get changes(): readonly GovernorChange[] {
      return changes;
    },
    setBudget(budgetMs: number) {
      if (budgetMs !== budget) {
        budget = budgetMs;
        clear();
      }
    },
    /** Forget the window, e.g. after a resize or when frames stop being comparable. */
    reset() {
      clear();
    },
    /**
     * Record one frame interval. Returns the new tier when a change is decided,
     * otherwise null.
     */
    observe(now: number, intervalMs: number, idle = false): QualityTier | null {
      if (idle) {
        clear();
        return null;
      }
      if (now - lastChange < SETTLE_MS) {
        clear();
        return null;
      }
      if (intervalMs > MAX_FRAME_MS || intervalMs <= 0) {
        return null;
      }
      times.push(now);
      intervals.push(intervalMs);
      while (times.length > 0 && times[0]! < now - WINDOW_MS) {
        times.shift();
        intervals.shift();
      }
      if (now - lastEvaluation < EVALUATE_EVERY_MS) {
        return null;
      }
      lastEvaluation = now;
      const span = now - times[0]!;
      if (span < Math.min(WINDOW_MS, DOWN_HOLD_MS) * 0.9) {
        return null;
      }
      const p95 = percentile(
        [...intervals].sort((a, b) => a - b),
        0.95,
      );
      const coolingDown = now - lastChange < COOLDOWN_MS;
      if (p95 > budget * DOWN_RATIO) {
        underSince = null;
        if (tier !== "eco" && !coolingDown) {
          if (now - lastUp < PROBE_MS) {
            ceiling = stepTier(tier, -1);
          }
          return change(now, stepTier(tier, -1), p95);
        }
        return null;
      }
      if (p95 <= budget * UP_RATIO) {
        // The whole current window already holds the cadence: count from its first frame.
        underSince ??= times[0]!;
        if (compareTiers(tier, ceiling) < 0 && !coolingDown && now - underSince >= UP_HOLD_MS) {
          lastUp = now;
          return change(now, stepTier(tier, 1), p95);
        }
        return null;
      }
      underSince = null;
      return null;
    },
  };
}

export type Governor = ReturnType<typeof createGovernor>;

/** Pointer inactivity after which an automatic display drops to the idle cadence. */
export const IDLE_AFTER_MS = 120_000;
export const IDLE_FPS = 15;

export function isIdle(
  now: number,
  lastActivity: number,
  focused: boolean,
  threshold = IDLE_AFTER_MS,
): boolean {
  return !focused || now - lastActivity >= threshold;
}

export function frameBudgetMs(fps: number): number {
  return 1000 / fps;
}
