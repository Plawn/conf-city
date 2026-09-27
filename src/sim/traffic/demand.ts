import { type Infrastructure, METRO_SHARE } from "../../domain/mobility";
import type { CityMeta, CityMetrics, NodeTelemetry } from "../../domain/types";
import type { Sim, TrafficRoute } from "./pool";

export function liveTelemetry(t: NodeTelemetry | undefined, now: number): t is NodeTelemetry {
  return !!t && t.liveness !== "down" && t.liveness !== "unknown" && now - t.lastSeen < 30_000;
}
export function writeDemand(
  sim: Sim,
  routes: TrafficRoute[],
  telemetry: Map<string, NodeTelemetry> | undefined,
  infra: Infrastructure,
  visible: Set<string> | undefined,
  now: number,
  cityMetrics?: Map<string, CityMetrics>,
  cityMeta?: Map<string, CityMeta>,
  ambientRate = 0,
) {
  routes.forEach((route, i) => {
    const enabled =
      !visible ||
      ((!route.cityId || visible.has(route.cityId)) &&
        (!route.targetCityId || visible.has(route.targetCityId)));
    sim.enabled[i] = enabled ? 1 : 0;
    const share = infra.cities[route.cityId ?? ""] === 2 ? 1 - METRO_SHARE : 1;
    let rate = 0;
    let flow = 0;
    if (route.sourceAddr) {
      const t = telemetry?.get(route.sourceAddr);
      if (liveTelemetry(t, now)) {
        flow = Math.max(0, t.metrics.netTxKbps ?? (t.metrics.rps ?? 0) * 20);
        rate = route.rate ?? 0.15 + 0.5 * Math.min(flow / 2000, 3);
      }
    } else if (route.ambientCityId) {
      const m = cityMetrics?.get(route.ambientCityId);
      const cores = cityMeta?.get(route.ambientCityId)?.cpuCores ?? 1;
      // Ambient city life is decorative; only its intensity follows host CPU.
      rate =
        0.05 +
        (m && now - m.at < 30_000
          ? 0.25 * Math.min(1, (m.cpuUsedCores ?? 0) / Math.max(1, cores))
          : 0);
    } else {
      rate = route.rate ?? ambientRate;
    }
    sim.rate[i] = enabled && Number.isFinite(rate) ? route.rateScale * rate * share : 0;
    sim.truckProb[i] = flow > 1500 ? 0.5 : flow > 400 ? 0.25 : 0.05;
  });
}
