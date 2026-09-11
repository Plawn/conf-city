/**
 * User "Tweaks": per-budget overrides applied on top of the quality tier so a
 * setting can be judged by eye and with the pipeline profiler on the target
 * machine. Precedence is tier → overrides → URL kill-switches (`?ao=0`…), which
 * only ever lower a budget. The tiers themselves never change.
 */
import { QUALITY_PROFILES, type QualityProfile, type QualityTier } from "./quality";

/** Flat, same names as the profile; an absent key means "the tier's value". */
export interface QualityOverrides {
  maxPixels?: number;
  maxDpr?: number;
  /** GTAO samples; 0 turns contact shading off. */
  ao?: number;
  aoDenoise?: boolean;
  /** Bloom mip chain scale; 0 turns bloom off. */
  bloomScale?: number;
  shadowMapSize?: number;
  shadowHz?: number;
  beaconShadow?: boolean;
  volume?: boolean;
  pointLights?: number;
  vehicleSpots?: number;
  maxCars?: number;
  maxTrucks?: number;
}

export type OverrideKey = keyof QualityOverrides;

type NumericKey = {
  [K in OverrideKey]: QualityOverrides[K] extends number | undefined ? K : never;
}[OverrideKey];
type BooleanKey = Exclude<OverrideKey, NumericKey>;

interface NumericRange {
  min: number;
  max: number;
  /** Integers, or powers of two for texture edges. */
  round?: "integer" | "pow2";
}

/** One table drives clamping, URL parsing, storage validation and the UI choices. */
export const OVERRIDE_RANGES: Record<NumericKey, NumericRange> = {
  maxPixels: { min: 500_000, max: 8_300_000 },
  maxDpr: { min: 0.5, max: 3 },
  ao: { min: 0, max: 32, round: "integer" },
  bloomScale: { min: 0, max: 1 },
  shadowMapSize: { min: 512, max: 4096, round: "pow2" },
  shadowHz: { min: 1, max: 30, round: "integer" },
  // The clustered node is sized once at renderer creation; more lights than that are dropped.
  pointLights: { min: 1, max: 1024, round: "integer" },
  vehicleSpots: { min: 0, max: 32, round: "integer" },
  maxCars: { min: 0, max: 600, round: "integer" },
  maxTrucks: { min: 0, max: 200, round: "integer" },
};

export const OVERRIDE_BOOLEAN_KEYS: readonly BooleanKey[] = ["aoDenoise", "beaconShadow", "volume"];

/** Canonical order, used by `formatTweaks` and the panel. */
export const OVERRIDE_KEYS: readonly OverrideKey[] = [
  "maxPixels",
  "maxDpr",
  "ao",
  "aoDenoise",
  "bloomScale",
  "shadowMapSize",
  "shadowHz",
  "beaconShadow",
  "volume",
  "pointLights",
  "vehicleSpots",
  "maxCars",
  "maxTrucks",
];

function isNumericKey(key: OverrideKey): key is NumericKey {
  return key in OVERRIDE_RANGES;
}

function clampNumber(key: NumericKey, value: number): number {
  const range = OVERRIDE_RANGES[key];
  const clamped = Math.min(range.max, Math.max(range.min, value));
  if (range.round === "integer") {
    return Math.round(clamped);
  }
  if (range.round === "pow2") {
    // Never above what was asked: a texture edge only steps down.
    return 2 ** Math.floor(Math.log2(clamped));
  }
  return clamped;
}

/** Unknown keys, wrong types and non-finite numbers are dropped; numbers are clamped. */
export function normalizeOverrides(raw: unknown): QualityOverrides {
  const out: QualityOverrides = {};
  if (!raw || typeof raw !== "object") {
    return out;
  }
  const record = raw as Record<string, unknown>;
  for (const key of OVERRIDE_KEYS) {
    const value = record[key];
    if (isNumericKey(key)) {
      const number = typeof value === "string" ? Number(value) : value;
      if (typeof number === "number" && Number.isFinite(number)) {
        out[key] = clampNumber(key, number);
      }
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (value === "1" || value === "0" || value === "true" || value === "false") {
      out[key] = value === "1" || value === "true";
    }
  }
  return out;
}

export function hasOverrides(overrides: QualityOverrides): boolean {
  return OVERRIDE_KEYS.some((key) => overrides[key] !== undefined);
}

export function overrideCount(overrides: QualityOverrides): number {
  return OVERRIDE_KEYS.filter((key) => overrides[key] !== undefined).length;
}

/**
 * The tier's profile with the overrides applied. Returns `base` itself when the
 * result is equal field for field so consumers keyed on identity never rebuild
 * for a no-op tweak. `base` is never mutated.
 */
export function mergeQualityProfile(
  base: QualityProfile,
  overrides: QualityOverrides,
): QualityProfile {
  const clean = normalizeOverrides(overrides);
  const samples = clean.ao ?? base.ao.samples;
  const enabled = clean.ao === undefined ? base.ao.enabled : samples > 0;
  // Denoise only means something once contact shading runs.
  const denoise = enabled ? (clean.aoDenoise ?? base.ao.denoise) : base.ao.denoise;
  const aoChanged =
    enabled !== base.ao.enabled || samples !== base.ao.samples || denoise !== base.ao.denoise;
  const merged: QualityProfile = {
    ...base,
    ao: aoChanged ? { enabled, samples, denoise } : base.ao,
  };
  for (const key of OVERRIDE_KEYS) {
    const value = clean[key];
    if (value === undefined || key === "ao" || key === "aoDenoise") {
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return profilesEqual(merged, base) ? base : merged;
}

function profilesEqual(a: QualityProfile, b: QualityProfile): boolean {
  for (const key of Object.keys(a) as (keyof QualityProfile)[]) {
    if (key === "ao") {
      continue;
    }
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return (
    a.ao.enabled === b.ao.enabled && a.ao.samples === b.ao.samples && a.ao.denoise === b.ao.denoise
  );
}

/** Effective profile for a tier, memoised nowhere: callers cache by `(tier, overrides)`. */
export function effectiveProfile(tier: QualityTier, overrides: QualityOverrides): QualityProfile {
  return mergeQualityProfile(QUALITY_PROFILES[tier], overrides);
}

/** `?tweaks=ao:0,bloomScale:0.25,volume:0`: booleans as 0|1, unknown pairs ignored. */
export function parseTweaks(text: string | null | undefined): QualityOverrides {
  const raw: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    raw[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return normalizeOverrides(raw);
}

/** Inverse of `parseTweaks`, in canonical key order; "" when nothing is overridden. */
export function formatTweaks(overrides: QualityOverrides): string {
  const parts: string[] = [];
  for (const key of OVERRIDE_KEYS) {
    const value = overrides[key];
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}:${typeof value === "boolean" ? (value ? 1 : 0) : value}`);
  }
  return parts.join(",");
}
