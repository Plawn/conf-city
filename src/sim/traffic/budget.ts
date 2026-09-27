import type { TrafficRoute } from "./pool";

/** Sample physical lanes, not route count: duplicate links don't manufacture capacity. */
export function trafficBudgets(routes: TrafficRoute[], hardLimit: number) {
  const all = new Set<string>();
  const zones = new Map<string, Set<string>>();
  for (const route of routes) {
    const zone = route.zone ?? "network";
    let cells = zones.get(zone);
    if (!cells) {
      cells = new Set();
      zones.set(zone, cells);
    }
    for (let i = 0; i + 1 < route.points.length; i++) {
      const a = route.points[i]!;
      const b = route.points[i + 1]!;
      const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (length < 1e-5) {
        continue;
      }
      const dx = (b[0] - a[0]) / length;
      const dz = (b[2] - a[2]) / length;
      const lanes = new Set(route.lanes?.[i] ?? [0.25]);
      for (let d = 0; d < length; d += 0.4) {
        for (const lane of lanes) {
          const x = a[0] + dx * d - dz * lane;
          const z = a[2] + dz * d + dx * lane;
          const y = a[1] + ((b[1] - a[1]) * d) / length;
          const key = `${Math.round(x / 0.4)},${Math.round(y / 0.5)},${Math.round(z / 0.4)}`;
          cells.add(key);
          all.add(key);
        }
      }
    }
  }
  const capacity = (n: number) => (n === 0 ? 0 : Math.max(2, Math.floor(((n * 0.4) / 0.8) * 0.35)));
  return {
    total: Math.min(hardLimit, capacity(all.size)),
    zones: new Map(
      [...zones].map(([zone, cells]) => [zone, Math.min(hardLimit, capacity(cells.size))]),
    ),
  };
}
