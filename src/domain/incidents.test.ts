import { describe, expect, test } from "bun:test";
import { nodeIncident, telemetryUncertain } from "./incidents";
import type { NodeTelemetry } from "./types";

const sample = (liveness: NodeTelemetry["liveness"], errorRate = 0): NodeTelemetry => ({
  liveness,
  metrics: { errorRate },
  lastSeen: 100_000,
});

describe("current incidents", () => {
  test("reports existing failures on first sight, prioritising downtime over errors", () => {
    const down = nodeIncident(sample("down", 0.5))!;
    const degraded = nodeIncident(sample("degraded", 0.5))!;
    const errors = nodeIncident(sample("healthy", 0.5))!;
    expect(down.kind).toBe("down");
    expect(degraded.kind).toBe("degraded");
    expect(errors.kind).toBe("errors");
    expect(down.priority).toBeLessThan(degraded.priority);
    expect(degraded.priority).toBeLessThan(errors.priority);
    expect(down.fireIntensity).toBeGreaterThan(degraded.fireIntensity);
  });

  test("uses the alert threshold strictly and extinguishes on recovery", () => {
    expect(nodeIncident(sample("healthy", 0.01001))?.kind).toBe("errors");
    expect(nodeIncident(sample("healthy", 0.01))).toBeNull();
    expect(nodeIncident(sample("down"))).not.toBeNull();
    expect(nodeIncident(sample("healthy"))).toBeNull();
  });

  test("missing or unknown health alone does not start a fire", () => {
    expect(nodeIncident()).toBeNull();
    expect(nodeIncident(sample("unknown"))).toBeNull();
    expect(nodeIncident({ ...sample("healthy"), metrics: { cpu: 100 } })).toBeNull();
    // A metrics-only provider can still report a real error rate.
    expect(nodeIncident(sample("unknown", 0.03))?.kind).toBe("errors");
  });

  test("missing, unknown and stale telemetry cannot imply all clear", () => {
    expect(telemetryUncertain(undefined, 100_000)).toBe(true);
    expect(telemetryUncertain(sample("unknown"), 100_000)).toBe(true);
    expect(telemetryUncertain(sample("healthy"), 130_001)).toBe(true);
    expect(telemetryUncertain(sample("healthy"), 100_000)).toBe(false);
  });
});
