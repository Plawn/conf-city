import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import type { IslandPalette } from "../domain/biome";
import { signedArea } from "../layout/geometry";
import type { Vec2 } from "../layout/types";

/**
 * The solid ground of one city: its outline extruded into a bevelled slab.
 *
 * The outline arrives in world `[x, z]`; a `THREE.Shape` lives in XY and the
 * extrusion runs along +Z, so the mesh is rotated by `-π/2` around X to lie flat.
 * That rotation maps `(x, y, z) → (x, z, -y)`: the shape's Y ends up as the
 * *negated* world Z, hence the `(x, z) → (x, -z)` mapping when building it.
 *
 * The slab is then translated down by its own `bbox.max.y` so its **top face sits
 * exactly at y = 0** — every building, slab and road keeps the Y values it has today.
 *
 * The biome paints it through **vertex colours**, so the beach costs no extra
 * group and no extra draw call: from the top down, the plateau is `ground`, the
 * bevel is the shore slope — its lower `sandBand` share is `sand` — and the wall
 * under it turns to `cliff` just below the waterline (water is at −0.6).
 */

const DEPTH = 1.2;
const BEVEL_THICKNESS = 0.35;
/** Fixed: the real waterline is `outline + BEVEL_SIZE`, and the foam shader is baked on it. */
const BEVEL_SIZE = 0.45;
/** Rings on the bevel — the sand band is a gradient between two of them. */
const BEVEL_SEGMENTS = 4;
/** Subdivisions of the wall, so the sand → cliff turn can happen at the waterline, not at the bottom. */
const WALL_STEPS = 4;
/** Below this the wall is cliff: a hair under the waterline, so sand never shows through the sea. */
const CLIFF_Y = -0.55;

export function IslandMesh({ outline, palette }: { outline: Vec2[]; palette: IslandPalette }) {
  const geometry = useMemo(() => {
    if (outline.length < 3) {
      return null;
    }

    // World [x, z] → shape [x, y], mirroring Z to cancel the rotation below.
    const shapePoints: Vec2[] = outline.map(([x, z]) => [x, -z]);
    // The mirror flips the winding. `ExtrudeGeometry` normalises it internally,
    // but forcing CCW here keeps the triangulation identical for a given outline.
    if (signedArea(shapePoints) < 0) {
      shapePoints.reverse();
    }

    const shape = new THREE.Shape();
    const first = shapePoints[0]!;
    shape.moveTo(first[0], first[1]);
    for (let i = 1; i < shapePoints.length; i++) {
      const p = shapePoints[i]!;
      shape.lineTo(p[0], p[1]);
    }
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH,
      steps: WALL_STEPS,
      bevelEnabled: true,
      bevelThickness: BEVEL_THICKNESS,
      bevelSize: BEVEL_SIZE,
      bevelSegments: BEVEL_SEGMENTS,
    });

    geo.rotateX(-Math.PI / 2);
    geo.computeBoundingBox();
    const top = geo.boundingBox?.max.y ?? 0;
    geo.translate(0, -top, 0);
    return geo;
  }, [outline]);

  // Colours are a separate memo: repainting a biome must not rebuild the extrusion.
  useMemo(() => {
    if (!geometry) {
      return;
    }
    paintByHeight(geometry, palette);
  }, [geometry, palette]);

  useLayoutEffect(() => {
    if (!geometry) {
      return;
    }
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry) {
    return null;
  }

  // `ExtrudeGeometry` emits exactly two groups (three 0.185 `buildLidFaces` /
  // `buildSideFaces`): group 0 is the flat caps — top and bottom — and group 1 is
  // every side wall, bevel rings included. Both read the vertex colours; they only
  // differ by finish, the plateau matte and the shore slightly wetter.
  return (
    <mesh
      matrixAutoUpdate={false}
      onUpdate={(mesh) => mesh.updateMatrix()}
      geometry={geometry}
      receiveShadow
    >
      <meshStandardMaterial attach="material-0" vertexColors roughness={0.95} metalness={0.05} />
      <meshStandardMaterial attach="material-1" vertexColors roughness={0.85} metalness={0.12} />
    </mesh>
  );
}

/** Writes the `color` attribute from each vertex's height: ground, sand, then cliff. */
function paintByHeight(geo: THREE.BufferGeometry, palette: IslandPalette) {
  const pos = geo.getAttribute("position");
  const count = pos.count;
  const existing = geo.getAttribute("color");
  const colors =
    existing && existing.count === count
      ? (existing.array as Float32Array)
      : new Float32Array(count * 3);
  const ground = new THREE.Color(palette.ground);
  const sand = new THREE.Color(palette.sand);
  const cliff = new THREE.Color(palette.cliff);
  // Top of the sand band on the bevel: the slope runs from 0 down to −BEVEL_THICKNESS.
  const sandTop = -BEVEL_THICKNESS * (1 - palette.sandBand);
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    let c: THREE.Color;
    if (y >= -1e-3) {
      c = ground;
    } else if (y >= -BEVEL_THICKNESS - 1e-3) {
      c = y < sandTop ? sand : ground;
    } else {
      c = y >= CLIFF_Y ? sand : cliff;
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  if (existing && existing.count === count) {
    existing.needsUpdate = true;
  } else {
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
}
