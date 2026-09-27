import { buildTrajectory } from "@/sim/mobility/trajectory";

/** Closed circular loop at platform height, sampled at 128 segments. */
export function circle(radius = 8) {
  return buildTrajectory(
    Array.from({ length: 129 }, (_, i) => {
      const a = (i / 128) * Math.PI * 2;
      return [Math.cos(a) * radius, 2.2, Math.sin(a) * radius] as [number, number, number];
    }),
    true,
  )!;
}
