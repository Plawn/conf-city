import type { GroupZone, RoadNetwork, Vec2 } from "./types";

export function translate(p: Vec2, dx: number, dz: number): Vec2 {
  return [p[0] + dx, p[1] + dz];
}

export function translateZone(zone: GroupZone, dx: number, dz: number): GroupZone {
  return {
    name: zone.name,
    outline: zone.outline.map((p) => translate(p, dx, dz)),
    center: translate(zone.center, dx, dz),
  };
}

export function translateRoads(roads: RoadNetwork, dx: number, dz: number): RoadNetwork {
  const routes = new Map(
    [...roads.routes].map(([key, route]) => [
      key,
      { points: route.points.map((p) => translate(p, dx, dz)) },
    ]),
  );
  return {
    segments: roads.segments.map((s) => ({
      ...s,
      points: s.points.map((p) => translate(p, dx, dz)),
    })),
    roundabouts: roads.roundabouts.map((r) => ({ ...r, center: translate(r.center, dx, dz) })),
    driveways: roads.driveways.map((d) => ({
      ...d,
      mouth: translate(d.mouth, dx, dz),
      door: translate(d.door, dx, dz),
    })),
    ring: roads.ring.map((p) => translate(p, dx, dz)),
    routes,
  };
}
