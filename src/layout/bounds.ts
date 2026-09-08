import type { PositionedNode } from "../domain/types";

export interface CityBounds {
  cx: number;
  cz: number;
  width: number;
  height: number;
}

export function computeBounds(nodes: PositionedNode[], padding = 0): CityBounds | null {
  if (nodes.length === 0) {
    return null;
  }
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position[0]);
    maxX = Math.max(maxX, n.position[0]);
    minZ = Math.min(minZ, n.position[2]);
    maxZ = Math.max(maxZ, n.position[2]);
  }
  return {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    width: maxX - minX + padding * 2,
    height: maxZ - minZ + padding * 2,
  };
}
