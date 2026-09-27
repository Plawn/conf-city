import type { CameraTarget } from "../domain/camera";
import type { PositionedNode } from "../domain/types";
import type { CityBounds } from "../layout/bounds";
import type { WorldLayout } from "../layout/types";

const DEFAULT_CAMERA_DISTANCE = 30;

export function resetTarget(): CameraTarget {
  return { lookAt: [0, 0, 0], distance: DEFAULT_CAMERA_DISTANCE, nonce: Date.now() };
}

/** Frames every visible island — shores included, not just the buildings. */
export function fitAllTarget(layout: WorldLayout, visibleCities: Set<string>): CameraTarget {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [cityId, city] of layout.cities) {
    if (!visibleCities.has(cityId)) {
      continue;
    }
    minX = Math.min(minX, city.bounds.cx - city.bounds.width / 2);
    maxX = Math.max(maxX, city.bounds.cx + city.bounds.width / 2);
    minZ = Math.min(minZ, city.bounds.cz - city.bounds.height / 2);
    maxZ = Math.max(maxZ, city.bounds.cz + city.bounds.height / 2);
  }
  if (minX === Infinity) {
    return resetTarget();
  }
  return targetFor({
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    width: maxX - minX,
    height: maxZ - minZ,
  });
}

export function fitCityTarget(layout: WorldLayout, cityId: string): CameraTarget | null {
  const city = layout.cities.get(cityId);
  if (!city) {
    return null;
  }
  return targetFor(city.bounds);
}

export function nodeTarget(node: PositionedNode): CameraTarget {
  return { lookAt: [...node.position], nonce: Date.now() };
}

function targetFor(bounds: CityBounds): CameraTarget {
  const span = Math.max(bounds.width, bounds.height, 4);
  return { lookAt: [bounds.cx, 0, bounds.cz], distance: span + 10, nonce: Date.now() };
}
