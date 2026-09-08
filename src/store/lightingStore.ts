import { create } from "zustand";
import { PARIS, type SolarClock, type SolarLocation, validLocation } from "../domain/solar";

const STORAGE_KEY = "conf-city-solar-location-v1";

export function readSolarLocation(storage?: Pick<Storage, "getItem">): SolarLocation {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    return validLocation(value) ? value : { ...PARIS };
  } catch {
    return { ...PARIS };
  }
}

interface LightingSettings {
  location: SolarLocation;
  clock: SolarClock;
  revision: number;
  setLocation: (location: SolarLocation) => void;
  preview: (instantUtcMs: number) => void;
  live: () => void;
}

function initialLocation() {
  try {
    return readSolarLocation(typeof window === "undefined" ? undefined : window.localStorage);
  } catch {
    return { ...PARIS };
  }
}

export const useLightingStore = create<LightingSettings>((set) => ({
  location: initialLocation(),
  clock: { mode: "live" },
  revision: 0,
  setLocation: (location) => {
    if (!validLocation(location)) {
      throw new Error("Latitude must be −90…90, longitude −180…180, with a valid IANA time zone.");
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
    } catch {
      // Settings still work when browser storage is unavailable.
    }
    set((s) => ({ location: { ...location }, revision: s.revision + 1 }));
  },
  preview: (instantUtcMs) => {
    if (!Number.isFinite(new Date(instantUtcMs).getTime())) {
      throw new Error("Invalid preview date.");
    }
    set((s) => ({ clock: { mode: "preview", instantUtcMs }, revision: s.revision + 1 }));
  },
  live: () => set((s) => ({ clock: { mode: "live" }, revision: s.revision + 1 })),
}));
