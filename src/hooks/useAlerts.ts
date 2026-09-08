import { useCallback, useEffect, useRef, useState } from "react";
import { ERROR_RATE_THRESHOLD } from "../domain/incidents";
import type { Alert } from "../domain/telemetry";
import type { LivenessStatus, NodeTelemetry } from "../domain/types";

const MAX_ALERTS = 100;
const SEVERITY: Record<LivenessStatus, number> = { healthy: 0, unknown: 1, degraded: 2, down: 3 };

interface Prev {
  liveness: LivenessStatus;
  errorRate: number;
  lastAlertAt: number;
}

let alertSeq = 0;

/**
 * Derives alerts from telemetry transitions:
 * liveness getting worse, recovery to healthy, and errorRate crossing a threshold.
 */
export function useAlerts(
  telemetry: Map<string, NodeTelemetry>,
  {
    errorRateThreshold = ERROR_RATE_THRESHOLD,
    cooldownMs = 30_000,
    onAlert,
  }: { errorRateThreshold?: number; cooldownMs?: number; onAlert?: (a: Alert) => void } = {},
) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const prevRef = useRef(new Map<string, Prev>());
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;

  useEffect(() => {
    const now = Date.now();
    const fresh: Alert[] = [];
    for (const [addr, t] of telemetry) {
      const errorRate = t.metrics.errorRate ?? 0;
      const prev = prevRef.current.get(addr);
      if (!prev) {
        // First sighting: seed silently (no alert storm on connect).
        prevRef.current.set(addr, { liveness: t.liveness, errorRate, lastAlertAt: 0 });
        continue;
      }
      let alert: Omit<Alert, "id" | "at"> | null = null;
      if (t.liveness !== prev.liveness) {
        const worse = SEVERITY[t.liveness] > SEVERITY[prev.liveness];
        if (worse && t.liveness !== "unknown") {
          alert = {
            node: addr,
            kind: "liveness",
            from: prev.liveness,
            to: t.liveness,
            tone: t.liveness === "down" ? "danger" : "warn",
            message: `${prev.liveness} → ${t.liveness}`,
          };
        } else if (t.liveness === "healthy" && prev.liveness !== "unknown") {
          alert = {
            node: addr,
            kind: "liveness",
            from: prev.liveness,
            to: t.liveness,
            tone: "ok",
            message: `recovered (${prev.liveness} → healthy)`,
          };
        }
      } else if (
        errorRate > errorRateThreshold &&
        prev.errorRate <= errorRateThreshold &&
        now - prev.lastAlertAt > cooldownMs
      ) {
        alert = {
          node: addr,
          kind: "errorRate",
          value: errorRate,
          tone: "warn",
          message: `error rate ${(errorRate * 100).toFixed(2)}%`,
        };
      }
      prevRef.current.set(addr, {
        liveness: t.liveness,
        errorRate,
        lastAlertAt: alert ? now : prev.lastAlertAt,
      });
      if (alert) {
        fresh.push({ ...alert, id: `a${++alertSeq}`, at: now });
      }
    }
    if (fresh.length > 0) {
      setAlerts((prev) => [...prev, ...fresh].slice(-MAX_ALERTS));
      for (const a of fresh) {
        onAlertRef.current?.(a);
      }
    }
  }, [telemetry, errorRateThreshold, cooldownMs]);

  const clear = useCallback(() => setAlerts([]), []);
  return { alerts, clear };
}
