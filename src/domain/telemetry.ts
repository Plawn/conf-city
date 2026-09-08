import type { LivenessStatus } from "@proxy/protocol";

/** One point of metric history for a node. */
export interface MetricSample {
  t: number;
  cpu?: number;
  memoryMb?: number;
  rps?: number;
  latencyMs?: number;
  errorRate?: number;
}

export type AlertTone = "ok" | "warn" | "danger";

export interface Alert {
  id: string;
  node: string; // "cityId/nodeId"
  kind: "liveness" | "errorRate";
  from?: LivenessStatus;
  to?: LivenessStatus;
  value?: number;
  at: number;
  tone: AlertTone;
  message: string;
}
