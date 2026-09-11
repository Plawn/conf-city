/** CPU side of the clustered lights node: bounds, texture packing, depth sorting and Z slices. */
import { type Light, type Matrix4, type PointLight, type SpotLight, Vector3 } from "three";

/** Texel rows per light in the lights texture. */
export const LIGHT_ROWS = 5;
/** Cone sentinels for point lights: `smoothstep(-2, -1.5, x)` is 1 for every x in [-1, 1]. */
export const POINT_CONE_COS = -2;
export const POINT_PENUMBRA_COS = -1.5;

export type ClusterKind = "point" | "spot";

export interface LightBound {
  center: Vector3;
  radius: number;
}

interface SpotLike extends SpotLight {
  colorNode?: unknown;
}

/** Points cluster as upstream; spots only when opted in, so the lighthouse beam keeps its material path. */
export function clusterKind(light: Light): ClusterKind | null {
  if (light.castShadow) {
    return null;
  }
  if ((light as PointLight).isPointLight) {
    return "point";
  }
  const spot = light as SpotLike;
  if (
    spot.isSpotLight &&
    spot.userData.clustered === true &&
    spot.map === null &&
    spot.colorNode === undefined &&
    spot.distance > 0
  ) {
    return "spot";
  }
  return null;
}

const _axis = new Vector3();

/**
 * Smallest sphere around a spot's lit volume: through apex and rim for narrow
 * cones, around the far rim for wide ones (the rim sphere holds the apex only
 * past 45°). `axis` must be unit length and point along the beam.
 */
export function coneBoundingSphere(
  apex: Vector3,
  axis: Vector3,
  range: number,
  angle: number,
  out: LightBound,
): LightBound {
  const cos = Math.cos(angle);
  if (cos <= 0) {
    out.center.copy(apex);
    out.radius = range;
  } else if (cos >= Math.SQRT1_2) {
    out.radius = range / (2 * cos);
    out.center.copy(apex).addScaledVector(axis, out.radius);
  } else {
    out.radius = range * Math.sin(angle);
    out.center.copy(apex).addScaledVector(axis, range * cos);
  }
  return out;
}

const _target = new Vector3();

/** World-space culling sphere of a clustered light; a zero distance means "everywhere" (= far). */
export function lightBound(
  light: PointLight | SpotLight,
  far: number,
  out: LightBound,
): LightBound {
  out.center.setFromMatrixPosition(light.matrixWorld);
  const range = light.distance > 0 ? light.distance : far;
  if (!(light as SpotLight).isSpotLight) {
    out.radius = range;
    return out;
  }
  const spot = light as SpotLight;
  _target.setFromMatrixPosition(spot.target.matrixWorld);
  _axis.subVectors(_target, out.center);
  if (_axis.lengthSq() === 0) {
    out.radius = range;
    return out;
  }
  _axis.normalize();
  return coneBoundingSphere(out.center, _axis, range, spot.angle, out);
}

const _position = new Vector3();

/** Writes one light's five rows into column `column` of the packed texture data. */
export function packLight(
  data: Float32Array,
  lineSize: number,
  column: number,
  light: PointLight | SpotLight,
  bound: LightBound,
): void {
  const offset = column * 4;
  data[offset] = bound.center.x;
  data[offset + 1] = bound.center.y;
  data[offset + 2] = bound.center.z;
  data[offset + 3] = bound.radius;
  _position.setFromMatrixPosition(light.matrixWorld);
  let row = lineSize + offset;
  data[row] = _position.x;
  data[row + 1] = _position.y;
  data[row + 2] = _position.z;
  data[row + 3] = light.distance;
  row += lineSize;
  data[row] = light.color.r * light.intensity;
  data[row + 1] = light.color.g * light.intensity;
  data[row + 2] = light.color.b * light.intensity;
  data[row + 3] = light.decay;
  row += lineSize;
  if ((light as SpotLight).isSpotLight) {
    const spot = light as SpotLight;
    // three's convention: the stored direction points from the target back to the lamp.
    _target.setFromMatrixPosition(spot.target.matrixWorld);
    _axis.subVectors(_position, _target).normalize();
    data[row] = _axis.x;
    data[row + 1] = _axis.y;
    data[row + 2] = _axis.z;
    data[row + 3] = Math.cos(spot.angle);
    data[row + lineSize] = Math.cos(spot.angle * (1 - spot.penumbra));
  } else {
    data[row] = 0;
    data[row + 1] = 0;
    data[row + 2] = 1;
    data[row + 3] = POINT_CONE_COS;
    data[row + lineSize] = POINT_PENUMBRA_COS;
  }
  data[row + lineSize + 1] = 0;
  data[row + lineSize + 2] = 0;
  data[row + lineSize + 3] = 0;
}

const _view = new Vector3();

/** View-space Z of each bound centre, then `order` holds indices sorted near to far. */
export function sortByViewZ(
  bounds: readonly LightBound[],
  count: number,
  viewMatrix: Matrix4,
  viewZ: Float32Array,
  order: number[],
): void {
  for (let i = 0; i < count; i++) {
    _view.copy(bounds[i]!.center).applyMatrix4(viewMatrix);
    viewZ[i] = _view.z;
    order[i] = i;
  }
  order.length = count;
  order.sort((a, b) => viewZ[a]! - viewZ[b]!);
}

/**
 * Per exponential depth slice, the `[start, end)` range of sorted lights whose
 * sphere overlaps it; written as `x, y` of each slice's texel in `out`.
 */
export function sliceRanges(
  viewZ: Float32Array,
  radius: Float32Array,
  order: readonly number[],
  count: number,
  near: number,
  far: number,
  slices: number,
  out: Float32Array,
): void {
  for (let z = 0; z < slices; z++) {
    const sliceNear = -(near * (far / near) ** (z / slices));
    const sliceFar = -(near * (far / near) ** ((z + 1) / slices));
    let rangeStart = count;
    let rangeEnd = 0;
    for (let i = 0; i < count; i++) {
      const index = order[i]!;
      const vz = viewZ[index]!;
      const r = radius[index]!;
      if (vz + r >= sliceFar && vz - r <= sliceNear) {
        if (i < rangeStart) {
          rangeStart = i;
        }
        rangeEnd = i + 1;
      }
    }
    if (rangeStart >= count) {
      rangeStart = 0;
      rangeEnd = 0;
    }
    out[z * 4] = rangeStart;
    out[z * 4 + 1] = rangeEnd;
  }
}

export function createBound(): LightBound {
  return { center: new Vector3(), radius: 0 };
}
