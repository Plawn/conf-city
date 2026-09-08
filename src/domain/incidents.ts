import type { NodeTelemetry } from "./types";

/** Shared by live alerts, the attention list and building fires. */
export const ERROR_RATE_THRESHOLD = 0.01;
export const TELEMETRY_STALE_MS = 30_000;

export interface NodeIncident {
  kind: "down" | "degraded" | "errors";
  label: string;
  tone: "danger" | "warn";
  priority: number;
  fireIntensity: number;
}

/** Current reported state, including incidents already present in the first snapshot. */
export function nodeIncident(t?: NodeTelemetry): NodeIncident | null {
  if (!t) {
    return null;
  }
  if (t.liveness === "down") {
    return { kind: "down", label: "Unavailable", tone: "danger", priority: 0, fireIntensity: 1 };
  }
  if (t.liveness === "degraded") {
    return { kind: "degraded", label: "Degraded", tone: "warn", priority: 1, fireIntensity: 0.6 };
  }
  if ((t.metrics.errorRate ?? 0) > ERROR_RATE_THRESHOLD) {
    return {
      kind: "errors",
      label: "High error rate",
      tone: "warn",
      priority: 2,
      fireIntensity: 0.45,
    };
  }
  return null;
}

export function telemetryUncertain(t: NodeTelemetry | undefined, now: number): boolean {
  return !t || t.liveness === "unknown" || now - t.lastSeen > TELEMETRY_STALE_MS;
}
