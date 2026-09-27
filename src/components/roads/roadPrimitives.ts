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

/** A flat annulus drawn at exactly `angles` (one increasing turn), so pieces cut on the same circle meet it edge to edge. */
export function annulus(
  inner: number,
  outer: number,
  y: number,
  center: Vec2,
  angles: number[],
): THREE.BufferGeometry {
  const n = angles.length;
  const positions = new Float32Array(n * 6);
  const normals = new Float32Array(n * 6);
  const uvs = new Float32Array(n * 4);
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.cos(angles[i]!);
    const s = Math.sin(angles[i]!);
    positions.set([center[0] + outer * c, y, center[1] + outer * s], i * 6);
    positions.set([center[0] + inner * c, y, center[1] + inner * s], i * 6 + 3);
    normals[i * 6 + 1] = 1;
    normals[i * 6 + 4] = 1;
    uvs.set([i / n, 1, i / n, 0], i * 4);
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    index.push(a, a + 1, b + 1, a, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(index);
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
