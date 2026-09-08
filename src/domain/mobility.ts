export type CityUpgrade = 0 | 1 | 2;
export interface Infrastructure {
  cities: Record<string, CityUpgrade>;
  bridges: Record<string, boolean>;
}
export const UPGRADE_SECONDS = 20;
export const METRO_SECONDS = 45;
export const CONSTRUCTION_SECONDS = 5;
export const METRO_SHARE = 0.45;
export const QUEUE_THRESHOLD = 3;
export const CLEAR_SECONDS = 6;
export interface ConstructionPressure {
  load: number;
  queued: number;
  position?: [number, number, number];
  accessCities?: string[];
}
export interface Construction {
  key: string;
  kind: "roads" | "bridge" | "metro";
  remaining: number;
  position?: [number, number, number];
  accessCities?: string[];
}
export interface ConstructionObservation {
  key: string;
  seconds: number;
  required: number;
  clearSeconds: number;
  reason: "queue" | "occupancy";
  queued: number;
  position?: [number, number, number];
}

/** Observe real visible time. Brief gaps in a queue no longer erase all construction progress. */
export function advanceConstruction(
  elapsed: Map<string, ConstructionObservation>,
  jobs: Construction[],
  infra: Infrastructure,
  loads: Record<string, number | ConstructionPressure>,
  dt: number,
): { started: Construction[]; completed: Construction[]; observations: ConstructionObservation[] } {
  for (const key of elapsed.keys()) {
    if (!(key in loads)) {
      elapsed.delete(key);
    }
  }
  const completed: Construction[] = [];
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i]!;
    const id = job.key.slice(job.key.indexOf(":") + 1);
    const done =
      job.kind === "bridge"
        ? infra.bridges[id]
        : (infra.cities[id] ?? 0) >= (job.kind === "metro" ? 2 : 1);
    if (!(job.key in loads) || done) {
      jobs.splice(i, 1);
      continue;
    }
    job.remaining -= dt;
    if (job.remaining <= 0) {
      completed.push(job);
      jobs.splice(i, 1);
      elapsed.delete(job.key);
    }
  }
  const started: Construction[] = [];
  for (const [key, value] of Object.entries(loads)) {
    if (jobs.some((j) => j.key === key) || completed.some((j) => j.key === key)) {
      continue;
    }
    const bridge = key.startsWith("bridge:");
    const id = key.slice(key.indexOf(":") + 1);
    const stage = bridge ? (infra.bridges[id] ? 1 : 0) : (infra.cities[id] ?? 0);
    if (bridge ? stage > 0 : stage >= 2) {
      elapsed.delete(key);
      continue;
    }
    const pressure = typeof value === "number" ? { load: value, queued: 0 } : value;
    const blocked = pressure.queued >= QUEUE_THRESHOLD;
    const busy = blocked || pressure.load >= 0.8;
    const observation = elapsed.get(key) ?? {
      key,
      seconds: 0,
      required: stage === 1 ? METRO_SECONDS : UPGRADE_SECONDS,
      clearSeconds: 0,
      reason: "occupancy" as const,
      queued: 0,
    };
    if (!busy) {
      observation.clearSeconds += dt;
      if (observation.clearSeconds >= CLEAR_SECONDS) {
        elapsed.delete(key);
      }
      continue;
    }
    observation.seconds += dt;
    observation.required = stage === 1 ? METRO_SECONDS : UPGRADE_SECONDS;
    observation.clearSeconds = 0;
    observation.reason = blocked ? "queue" : "occupancy";
    observation.queued = pressure.queued;
    observation.position = pressure.position;
    elapsed.set(key, observation);
    if (observation.seconds >= observation.required) {
      const job: Construction = {
        key,
        kind: bridge ? "bridge" : stage === 0 ? "roads" : "metro",
        remaining: CONSTRUCTION_SECONDS,
        position: pressure.position,
        accessCities: pressure.accessCities,
      };
      jobs.push(job);
      started.push(job);
      elapsed.delete(key);
    }
  }
  return { started, completed, observations: [...elapsed.values()].map((o) => ({ ...o })) };
}
