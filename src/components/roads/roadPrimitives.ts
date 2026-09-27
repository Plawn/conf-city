import * as THREE from "three";
import { offsetPolyline } from "../../geo/polyline";
import type { Vec2 } from "../../layout/types";
import { buildRibbon } from "../geo/ribbon";

/** The Three.js pieces the road network is merged from: all indexed, position/normal/uv. */

type Vec3 = [number, number, number];

/** Paints a flat colour into a `color` attribute, so parts of different shades merge. */
export function paint(geometry: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function disc(radius: number, y: number, center: Vec2, segments = 16): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(radius, segments);
  g.rotateX(-Math.PI / 2);
  g.translate(center[0], y, center[1]);
  return g;
}

export function ring(inner: number, outer: number, y: number, center: Vec2): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(inner, outer, 28);
  g.rotateX(-Math.PI / 2);
  g.translate(center[0], y, center[1]);
  return g;
}

const lift = (points: Vec2[], y: number): Vec3[] => points.map(([x, z]) => [x, y, z]);

/** A ribbon along the polyline, at height `y`; `null` when there is nothing to draw. */
export function ribbon(points: Vec2[], width: number, y: number): THREE.BufferGeometry | null {
  if (points.length < 2) {
    return null;
  }
  return buildRibbon(lift(points, y), width);
}

/** The band between lateral offsets `d0` and `d1` of the polyline (right is positive). */
export function band(
  points: Vec2[],
  d0: number,
  d1: number,
  y: number,
): THREE.BufferGeometry | null {
  if (points.length < 2) {
    return null;
  }
  return ribbon(offsetPolyline(points, (d0 + d1) / 2), Math.abs(d1 - d0), y);
}
