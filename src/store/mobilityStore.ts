import { create } from "zustand";
import type { TrafficStats } from "../components/traffic/lifecycle";
import type { Construction, ConstructionObservation, Infrastructure } from "../domain/mobility";

const KEY = "conf-city-mobility-v1";
interface Saved {
  worlds: Record<string, Infrastructure>;
  ingress: Record<string, boolean>;
}
function read(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (
      s &&
      typeof s.worlds === "object" &&
      s.worlds &&
      typeof s.ingress === "object" &&
      s.ingress
    ) {
      const worlds: Saved["worlds"] = {};
      for (const [key, value] of Object.entries(s.worlds)) {
        const v = value as Infrastructure;
        if (!v?.cities || !v.bridges) {
          continue;
        }
        worlds[key] = {
          cities: Object.fromEntries(
            Object.entries(v.cities).filter(([, n]) => n === 0 || n === 1 || n === 2),
          ),
          bridges: Object.fromEntries(Object.entries(v.bridges).filter(([, b]) => b === true)),
        };
      }
      return {
        worlds,
        ingress: Object.fromEntries(
          Object.entries(s.ingress as Record<string, boolean>).filter(
            ([, b]) => typeof b === "boolean",
          ),
        ),
      };
    }
  } catch {
    /* Storage can be unavailable or contain an older schema. */
  }
  return { worlds: {}, ingress: {} };
}
interface MobilityState extends Saved {
  worldKey: string;
  resetVersion: number;
  stats: TrafficStats | null;
  construction: Construction[];
  observations: ConstructionObservation[];
  events: string[];
  setWorld: (key: string) => void;
  report: (
    stats: TrafficStats,
    construction: Construction[],
    observations?: ConstructionObservation[],
  ) => void;
  commit: (job: Construction) => void;
  syncBridgeAccesses: (bridges: { key: string; cityA: string; cityB: string }[]) => void;
  setIngress: (address: string, value: boolean) => void;
  reset: () => void;
}
function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ worlds: s.worlds, ingress: s.ingress }));
  } catch {
    /* Session state still works. */
  }
}
export const EMPTY_INFRA: Infrastructure = { cities: {}, bridges: {} };
export const useMobilityStore = create<MobilityState>((set, get) => ({
  ...read(),
  resetVersion: 0,
  worldKey: "",
  stats: null,
  construction: [],
  observations: [],
  events: [],
  setWorld: (worldKey) =>
    set({ worldKey, stats: null, construction: [], observations: [], events: [] }),
  report: (stats, construction, observations = []) => set({ stats, construction, observations }),
  commit: (job) => {
    const s = get();
    const current = s.worlds[s.worldKey] ?? EMPTY_INFRA;
    const id = job.key.slice(job.key.indexOf(":") + 1);
    const infra: Infrastructure = {
      cities: { ...current.cities },
      bridges: { ...current.bridges },
    };
    if (job.kind === "bridge") {
      infra.bridges[id] = true;
      for (const city of job.accessCities ?? []) {
        infra.cities[city] = infra.cities[city] === 2 ? 2 : 1;
      }
    } else {
      infra.cities[id] = job.kind === "metro" || infra.cities[id] === 2 ? 2 : 1;
    }
    const message = `${id}: ${job.kind === "bridge" ? "bridge widened · two lanes each way" : job.kind === "metro" ? "metro opened · 45% modal share" : "roads widened"}`;
    set({
      worlds: { ...s.worlds, [s.worldKey]: infra },
      events: [message, ...s.events].slice(0, 8),
    });
    save(get());
  },
  syncBridgeAccesses: (bridges) => {
    const s = get();
    const current = s.worlds[s.worldKey];
    if (!current) {
      return;
    }
    const cities = { ...current.cities };
    let changed = false;
    for (const bridge of bridges) {
      if (!current.bridges[bridge.key]) {
        continue;
      }
      for (const id of [bridge.cityA, bridge.cityB]) {
        if (!cities[id]) {
          cities[id] = 1;
          changed = true;
        }
      }
    }
    if (changed) {
      set({ worlds: { ...s.worlds, [s.worldKey]: { ...current, cities } } });
      save(get());
    }
  },
  setIngress: (address, value) => {
    set((s) => ({ ingress: { ...s.ingress, [address]: value } }));
    save(get());
  },
  reset: () => {
    const s = get();
    set({
      resetVersion: s.resetVersion + 1,
      worlds: { ...s.worlds, [s.worldKey]: EMPTY_INFRA },
      construction: [],
      observations: [],
      events: [],
    });
    save(get());
  },
}));
