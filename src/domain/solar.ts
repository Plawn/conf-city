import { DateTime, IANAZone } from "luxon";
import { getPosition, getTimes } from "suncalc";

export interface SolarLocation {
  latitude: number;
  longitude: number;
  timeZone: string;
}

export const PARIS: SolarLocation = {
  latitude: 48.8566,
  longitude: 2.3522,
  timeZone: "Europe/Paris",
};

export type SolarClock = { mode: "live" } | { mode: "preview"; instantUtcMs: number };

export function validLocation(value: unknown): value is SolarLocation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as SolarLocation;
  return (
    Number.isFinite(v.latitude) &&
    Math.abs(v.latitude) <= 90 &&
    Number.isFinite(v.longitude) &&
    Math.abs(v.longitude) <= 180 &&
    typeof v.timeZone === "string" &&
    IANAZone.isValidZone(v.timeZone)
  );
}

export function smoothRange(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** SunCalc 2 uses degrees clockwise from north. World: east +X, north -Z. */
export function solarDirection(azimuth: number, altitude: number): [number, number, number] {
  const a = (azimuth * Math.PI) / 180;
  const h = (altitude * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(h), Math.sin(h), -Math.cos(a) * Math.cos(h)];
}

export function lightingAtAltitude(altitude: number) {
  const day = smoothRange(-8, 12, altitude);
  return {
    day,
    night: 1 - smoothRange(-6, 0, altitude),
    sunIntensity: altitude <= 0 ? 0 : 3.2 * smoothRange(0, 30, altitude),
    warmth: 1 - smoothRange(2, 25, altitude),
    ambientIntensity: 0.16 + day * 0.18,
    environmentIntensity: 0.45 + day * 0.45,
  };
}

export function computeSolarState(instantUtcMs: number, location: SolarLocation) {
  if (!Number.isFinite(instantUtcMs) || !validLocation(location)) {
    throw new Error("Invalid solar date or location");
  }
  const date = new Date(instantUtcMs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid solar date");
  }
  const position = getPosition(date, location.latitude, location.longitude);
  // Anchor event lookup to the selected civil date, including just after midnight.
  const noon = DateTime.fromMillis(instantUtcMs, { zone: location.timeZone })
    .set({ hour: 12, minute: 0, second: 0, millisecond: 0 })
    .toJSDate();
  const times = getTimes(noon, location.latitude, location.longitude);
  return {
    instantUtcMs,
    ...position,
    ...lightingAtAltitude(position.altitude),
    direction: solarDirection(position.azimuth, position.altitude),
    sunrise: times.sunrise?.getTime() ?? null,
    sunset: times.sunset?.getTime() ?? null,
    polar: times.alwaysUp ? ("day" as const) : times.alwaysDown ? ("night" as const) : null,
  };
}

export type SolarState = ReturnType<typeof computeSolarState>;

export function resolveSolarInstant(clock: SolarClock, now: number): number {
  return clock.mode === "live" ? now : clock.instantUtcMs;
}

/** Reject spring gaps by round-tripping; choose the first instant in autumn overlaps. */
export function parseLocalPreview(value: string, timeZone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !IANAZone.isValidZone(timeZone)) {
    throw new Error("Enter a valid date, time and time zone.");
  }
  const local = DateTime.fromISO(value, { zone: timeZone });
  if (!local.isValid || local.toFormat("yyyy-MM-dd'T'HH:mm") !== value) {
    throw new Error("This local time does not exist. Choose another time.");
  }
  return Math.min(...local.getPossibleOffsets().map((d) => d.toMillis()));
}
