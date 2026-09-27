import { makeDriver } from "@/geo/drivable";
import type { RoadNetwork, Vec2 } from "@/layout/types";
import type { TrafficRoute } from "@/sim/traffic/pool";
export function roundaboutRoutes(): TrafficRoute[] {
  const ew: Vec2[] = [
    [-8, 0],
    [0, 0],
    [8, 0],
  ];
  const ns: Vec2[] = [
    [0, -8],
    [0, 0],
    [0, 8],
  ];
  const net: RoadNetwork = {
    segments: [ew, ns].flatMap((path) =>
      path.slice(1).map((p, i) => ({ points: [path[i]!, p], klass: "street" as const })),
    ),
    roundabouts: [{ center: [0, 0], radius: 1.2, klass: "avenue" }],
    driveways: [],
    ring: [],
    routes: new Map(),
  };
  const driver = makeDriver([net]);
  return [ew, ns, [...ew].reverse(), [...ns].reverse()].map((points) => ({
    ...driver.street(points),
    rateScale: 1,
  }));
}
