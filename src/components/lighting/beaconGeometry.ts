import { ConeGeometry } from "three";

/** Lamp at the origin, beam opening along +Z (the same axis as the real spotlight). */
export function createBeaconGeometry(radius: number, length: number, openEnded = true) {
  const geometry = new ConeGeometry(radius, length, 32, 1, openEnded);
  geometry.translate(0, -length / 2, 0);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}
