import { describe, expect, test } from "bun:test";
import { QUALITY_PROFILES, QUALITY_TIERS } from "@/domain/quality";
import {
  formatTweaks,
  hasOverrides,
  mergeQualityProfile,
  normalizeOverrides,
  overrideCount,
  parseTweaks,
} from "@/domain/qualityOverrides";

describe("mergeQualityProfile", () => {
  test("keeps the tier identity for empty and no-op overrides", () => {
    for (const tier of QUALITY_TIERS) {
      const base = QUALITY_PROFILES[tier];
      expect(mergeQualityProfile(base, {})).toBe(base);
      expect(mergeQualityProfile(base, { volume: base.volume })).toBe(base);
    }
    expect(mergeQualityProfile(QUALITY_PROFILES.balanced, { ao: 8 })).toBe(
      QUALITY_PROFILES.balanced,
    );
    // A value that clamps back onto the tier's value is still a no-op.
    expect(mergeQualityProfile(QUALITY_PROFILES.high, { pointLights: 5000 })).toBe(
      QUALITY_PROFILES.high,
    );
  });

  test("never mutates the tier and applies every key", () => {
    const snapshot = JSON.stringify(QUALITY_PROFILES);
    const merged = mergeQualityProfile(QUALITY_PROFILES.high, {
      maxPixels: 1_000_000,
      maxDpr: 1,
      ao: 8,
      aoDenoise: false,
      bloomScale: 0.25,
      shadowMapSize: 1024,
      shadowHz: 4,
      beaconShadow: false,
      volume: false,
      pointLights: 32,
      vehicleSpots: 4,
      maxCars: 60,
      maxTrucks: 15,
    });
    expect(JSON.stringify(QUALITY_PROFILES)).toBe(snapshot);
    expect(merged.tier).toBe("high");
    expect(merged).toMatchObject({
      maxPixels: 1_000_000,
      maxDpr: 1,
      ao: { enabled: true, samples: 8, denoise: false },
      bloomScale: 0.25,
      shadowMapSize: 1024,
      shadowHz: 4,
      beaconShadow: false,
      volume: false,
      pointLights: 32,
      vehicleSpots: 4,
      maxCars: 60,
      maxTrucks: 15,
    });
  });

  test("clamps and rounds out-of-range values", () => {
    const merged = mergeQualityProfile(QUALITY_PROFILES.high, {
      maxPixels: 1e9,
      pointLights: 5000,
      shadowMapSize: 3000,
      ao: -3,
      bloomScale: 2,
      shadowHz: 7.6,
    });
    expect(merged.maxPixels).toBe(8_300_000);
    expect(merged.pointLights).toBe(1024);
    expect(merged.shadowMapSize).toBe(2048);
    expect(merged.ao).toEqual({ enabled: false, samples: 0, denoise: true });
    expect(merged.bloomScale).toBe(1);
    expect(merged.shadowHz).toBe(8);
  });

  test("ignores non-finite numbers", () => {
    expect(mergeQualityProfile(QUALITY_PROFILES.high, { ao: Number.NaN })).toBe(
      QUALITY_PROFILES.high,
    );
  });

  test("ao semantics", () => {
    const eco = QUALITY_PROFILES.eco;
    const on = mergeQualityProfile(eco, { ao: 16 });
    expect(on.ao).toEqual({ enabled: true, samples: 16, denoise: false });
    expect(mergeQualityProfile(eco, { ao: 16, aoDenoise: true }).ao.denoise).toBe(true);
    // Denoise alone changes nothing while contact shading is off.
    expect(mergeQualityProfile(eco, { aoDenoise: true })).toBe(eco);
    const off = mergeQualityProfile(QUALITY_PROFILES.high, { ao: 0 });
    expect(off.ao.enabled).toBe(false);
    expect(off.ao.samples).toBe(0);
    // The ao object is reused when unchanged.
    expect(mergeQualityProfile(QUALITY_PROFILES.high, { volume: false }).ao).toBe(
      QUALITY_PROFILES.high.ao,
    );
  });
});

describe("tweaks text form", () => {
  test("round-trips in canonical order", () => {
    const text = "ao:0,bloomScale:0.25,volume:0,maxCars:60";
    const parsed = parseTweaks(text);
    expect(parsed).toEqual({ ao: 0, bloomScale: 0.25, volume: false, maxCars: 60 });
    expect(formatTweaks(parsed)).toBe("ao:0,bloomScale:0.25,volume:0,maxCars:60");
    expect(parseTweaks(formatTweaks(parsed))).toEqual(parsed);
  });

  test("drops garbage and unknown keys", () => {
    expect(parseTweaks("tier:eco, ao:abc ,,:3,pointLights:64,volume:maybe")).toEqual({
      pointLights: 64,
    });
    expect(parseTweaks("")).toEqual({});
    expect(parseTweaks(null)).toEqual({});
    expect(formatTweaks({})).toBe("");
  });

  test("normalizeOverrides validates stored JSON", () => {
    expect(normalizeOverrides(null)).toEqual({});
    expect(normalizeOverrides("ao:8")).toEqual({});
    expect(
      normalizeOverrides({ ao: "8", volume: "true", beaconShadow: 1, extra: 2, maxDpr: 9 }),
    ).toEqual({ ao: 8, volume: true, maxDpr: 3 });
  });

  test("counts overrides", () => {
    expect(hasOverrides({})).toBe(false);
    expect(hasOverrides({ ao: 0 })).toBe(true);
    expect(overrideCount({ ao: 0, volume: false, maxCars: undefined })).toBe(2);
  });
});
