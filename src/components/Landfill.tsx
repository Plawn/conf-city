import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { TERRAIN } from "../domain/nodeStyle";
import { signedArea } from "../layout/geometry";
import type { Vec2 } from "../layout/types";
import { NO_RAYCAST } from "./three/instancing";

/** Deck top: a hair under the island's plateau (y = 0), so the natural land covers the overlap. */
const DECK_TOP = -0.04;
const DECK_THICKNESS = 0.15;
/** Water sits at −0.6; the piles run from under it up to the deck. */
const PILE_BOTTOM = -1.2;
const PILE_STEP = 2.4;
const PILE_INSET = 0.35;
const PILE_COLOR = "#3e3e46";
const pileGeometry = new THREE.CylinderGeometry(0.14, 0.16, 1, 6);

/**
 * The part of an overbuilt island the machine's memory does not pay for: a
 * concrete deck over the water, on piles along its edge, drawn under the
 * natural ground (`CityLayout.land`) — the city visibly spills into the sea.
 */
export function Landfill({ outline }: { outline: Vec2[] }) {
  const deck = useMemo(() => {
    if (outline.length < 3) {
      return null;
    }
    // Same mirror as IslandMesh: shape Y is world −Z, undone by the −π/2 turn.
    const pts: Vec2[] = outline.map(([x, z]) => [x, -z]);
    if (signedArea(pts) < 0) {
      pts.reverse();
    }
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: DECK_THICKNESS, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, DECK_TOP - DECK_THICKNESS, 0);
    return geo;
  }, [outline]);

  const piles = useMemo(() => {
    if (outline.length < 3) {
      return [];
    }
    // Inset toward the centroid so the piles stand under the deck, not beside it.
    const cx = outline.reduce((a, p) => a + p[0], 0) / outline.length;
    const cz = outline.reduce((a, p) => a + p[1], 0) / outline.length;
    return alongRing(outline, PILE_STEP).map(([x, z]) => {
      const d = Math.hypot(x - cx, z - cz) || 1;
      return [x - ((x - cx) / d) * PILE_INSET, z - ((z - cz) / d) * PILE_INSET] as Vec2;
    });
  }, [outline]);

  const pileMesh = useMemo(() => {
    if (piles.length === 0) {
      return null;
    }
    const mesh = new THREE.InstancedMesh(
      pileGeometry,
      new THREE.MeshStandardMaterial({ color: PILE_COLOR, roughness: 0.9 }),
      piles.length,
    );
    const m = new THREE.Matrix4();
    const height = DECK_TOP - DECK_THICKNESS - PILE_BOTTOM;
    piles.forEach(([x, z], i) => {
      m.makeScale(1, height, 1).setPosition(x, PILE_BOTTOM + height / 2, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.computeBoundingSphere();
    mesh.raycast = NO_RAYCAST;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }, [piles]);

  useLayoutEffect(() => {
    return () => {
      deck?.dispose();
      (pileMesh?.material as THREE.Material | undefined)?.dispose();
      pileMesh?.dispose();
    };
  }, [deck, pileMesh]);

  if (!deck) {
    return null;
  }
  return (
    <>
      <mesh geometry={deck} matrixAutoUpdate={false} receiveShadow raycast={NO_RAYCAST}>
        <meshStandardMaterial color={TERRAIN.landfill} roughness={0.9} />
      </mesh>
      {pileMesh && <primitive object={pileMesh} />}
    </>
  );
}

/** Points every `step` along a closed polygon, starting at its first vertex. */
function alongRing(poly: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = carry; d < len; d += step) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    carry = (((carry - len) % step) + step) % step;
  }
  return out;
}
