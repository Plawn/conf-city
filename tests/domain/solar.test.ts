import { describe, expect, test } from "bun:test";
import {
  computeSolarState,
  lightingAtAltitude,
  PARIS,
  parseLocalPreview,
  resolveSolarInstant,
  solarDirection,
  validLocation,
} from "@/domain/solar";

describe("geolocated sun", () => {
  test("SunCalc 2 azimuth maps east to +X and north to -Z", () => {
    for (const [azimuth, expected] of [
      [0, [0, 0, -1]],
      [90, [1, 0, 0]],
      [180, [0, 0, 1]],
      [270, [-1, 0, 0]],
    ] as const) {
      const direction = solarDirection(azimuth, 0);
      direction.forEach((v, i) => {
        expect(v).toBeCloseTo(expected[i]!, 8);
      });
    }
    expect(solarDirection(60, 90)[1]).toBeCloseTo(1, 8);
  });
  test("Paris sun is higher and days longer in summer", () => {
    const summer = computeSolarState(Date.parse("2026-06-21T12:00:00Z"), PARIS);
    const winter = computeSolarState(Date.parse("2026-12-21T12:00:00Z"), PARIS);
    expect(summer.altitude).toBeGreaterThan(60);
    expect(winter.altitude).toBeLessThan(20);
    expect(summer.sunset! - summer.sunrise!).toBeGreaterThan(winter.sunset! - winter.sunrise!);
    expect(summer.direction[2]).toBeGreaterThan(0.3);
  });
  test("instant and coordinates determine position, not the display zone", () => {
    const instant = Date.parse("2026-06-21T08:00:00Z");
    const a = computeSolarState(instant, PARIS);
    const b = computeSolarState(instant, { ...PARIS, timeZone: "America/New_York" });
    expect(a.direction).toEqual(b.direction);
    expect(a.direction[0]).toBeGreaterThan(0);
  });
  test("night is readable, direct sun switches off continuously at the horizon", () => {
    expect(lightingAtAltitude(-10).sunIntensity).toBe(0);
    expect(lightingAtAltitude(-10).ambientIntensity).toBeGreaterThan(0);
    expect(lightingAtAltitude(-6).night).toBe(1);
    expect(lightingAtAltitude(0).night).toBe(0);
    expect(lightingAtAltitude(0.001).sunIntensity).toBeLessThan(0.001);
  });
  test("polar dates have finite directions and absent events", () => {
    const location = { latitude: 78.22, longitude: 15.65, timeZone: "Arctic/Longyearbyen" };
    const summer = computeSolarState(Date.parse("2026-06-21T12:00Z"), location);
    const winter = computeSolarState(Date.parse("2026-12-21T12:00Z"), location);
    expect(summer.polar).toBe("day");
    expect(winter.polar).toBe("night");
    expect(summer.sunset).toBeNull();
    expect(winter.sunrise).toBeNull();
    expect(summer.direction.every(Number.isFinite)).toBe(true);
  });
  test("invalid input is rejected before reaching the renderer", () => {
    expect(validLocation({ ...PARIS, latitude: 91 })).toBe(false);
    expect(validLocation({ ...PARIS, longitude: Number.NaN })).toBe(false);
    expect(validLocation({ ...PARIS, timeZone: "Paris" })).toBe(false);
    expect(() => computeSolarState(Number.NaN, PARIS)).toThrow();
  });
});

describe("solar wall clock and local preview", () => {
  test("live jumps to wall time after sleep; preview stays fixed", () => {
    expect(resolveSolarInstant({ mode: "live" }, 86_400_000)).toBe(86_400_000);
    expect(resolveSolarInstant({ mode: "preview", instantUtcMs: 123 }, 86_400_000)).toBe(123);
  });
  test("Paris winter and summer offsets are handled without the browser zone", () => {
    expect(parseLocalPreview("2026-01-01T12:00", "Europe/Paris")).toBe(
      Date.parse("2026-01-01T11:00Z"),
    );
    expect(parseLocalPreview("2026-07-01T12:00", "Europe/Paris")).toBe(
      Date.parse("2026-07-01T10:00Z"),
    );
  });
  test("spring gap rejected and autumn overlap uses first occurrence", () => {
    expect(() => parseLocalPreview("2026-03-29T02:30", "Europe/Paris")).toThrow("does not exist");
    expect(parseLocalPreview("2026-10-25T02:30", "Europe/Paris")).toBe(
      Date.parse("2026-10-25T00:30Z"),
    );
    expect(() => parseLocalPreview("2026-02-30T12:00", "Europe/Paris")).toThrow();
  });
});
