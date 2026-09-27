import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TERRAIN } from "../domain/nodeStyle";
import { bridgeElevation, DECK_CLASS, deckHeight, deckWidth } from "../geo/drivable";
import { EDGE_INSET, LINE_WIDTH } from "../geo/markings";
import { offsetPolyline } from "../geo/polyline";
import { CLASS_STYLE } from "../geo/roadStyle";
import type { RoadClass, Vec2 } from "../layout/types";
import { loopWall } from "./geo/polygon";
import { buildRibbon } from "./geo/ribbon";
import { paint } from "./roads/roadPrimitives";

/** Rails sit on the deck's own edges (±width/2), so only their height is a constant. */
const RAIL_HEIGHT = 0.15;
/** One pylon roughly every PYLON_SPACING world units of span. */
const PYLON_SPACING = 6;
const PYLON_FOOT_Y = -0.9;
/** Edge lines ride just above the deck. */
const LINE_LIFT = 0.005;

/**
 * One inter-city deck, two guard rails and the pylons holding it, merged into
 * a single geometry (one draw call, no useFrame). `deck` is the span between
 * the two ramp ends (`bridgeDeck`), the same one every crossing drives.
 *
 * There is one mesh per bridge whatever its stage: an upgraded bridge is the
 * same span drawn at a wider `klass`, so the extra lanes appear on the sides
 * of the existing deck instead of a second deck hanging over it.
 */
export function BridgeMesh({
  deck,
  klass = DECK_CLASS,
}: {
  deck: [Vec2, Vec2];
  klass?: RoadClass;
}) {
  const geometry = useMemo(() => {
    const centre = bridgeElevation(deck, deck);
    // The ends come down onto the road they leave from, so the joint has no step.
    for (const end of [centre[0], centre[centre.length - 1]]) {
      if (end) {
        end[1] = TERRAIN.roadY;
      }
    }
    const width = deckWidth(klass);
    const ribbon = paint(buildRibbon(centre, width), CLASS_STYLE[klass].color);
    const parts: THREE.BufferGeometry[] = [ribbon];

    // Edge lines, as on the avenues it continues.
    const flat = centre.map(([x, , z]): Vec2 => [x, z]);
    for (const side of [-1, 1]) {
      const d = side * (width / 2 - EDGE_INSET);
      const line = offsetPolyline(flat, d).map(([x, z], i): [number, number, number] => [
        x,
        centre[i]![1] + LINE_LIFT,
        z,
      ]);
      parts.push(paint(buildRibbon(line, LINE_WIDTH), TERRAIN.roadDash));
    }

    // Rails ride the deck's own edges: `buildRibbon` lays out each point as
    // (right, left), so the offsets are already computed and mitred. The deck
    // rises and falls, so each rail is a wall built from its own edge heights.
    const pos = ribbon.getAttribute("position");
    for (const first of [0, 1]) {
      const edge: Vec2[] = [];
      const heights: number[] = [];
      for (let i = first; i < pos.count; i += 2) {
        edge.push([pos.getX(i), pos.getZ(i)]);
        heights.push(pos.getY(i));
      }
      const rail = loopWall(edge, 0, RAIL_HEIGHT, false);
      if (!rail) {
        continue;
      }
      const p = rail.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        p.setY(i, p.getY(i) + heights[i >> 1]!);
      }
      parts.push(paint(rail, TERRAIN.bridgeDeck));
    }

    // Pylons, evenly spread over the span so the spacing stays close to PYLON_SPACING.
    const [a, b] = deck;
    const spanLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bays = Math.max(1, Math.round(spanLength / PYLON_SPACING));
    for (let k = 1; k < bays; k++) {
      const u = k / bays;
      const height = deckHeight(u) - PYLON_FOOT_Y;
      const pylon = new THREE.CylinderGeometry(0.12, 0.15, height, 6);
      pylon.translate(
        a[0] + (b[0] - a[0]) * u,
        PYLON_FOOT_Y + height / 2,
        a[1] + (b[1] - a[1]) * u,
      );
      parts.push(paint(pylon, TERRAIN.bridgeDeck));
    }

    const merged = mergeGeometries(parts);
    for (const part of parts) {
      part.dispose();
    }
    return merged ?? new THREE.BufferGeometry();
  }, [deck, klass]);

  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      matrixAutoUpdate={false}
      onUpdate={(mesh) => mesh.updateMatrix()}
      geometry={geometry}
      castShadow
      receiveShadow
    >
      {/* The deck is the road it carries; the red "inter-city" semantics live on the route overlay. */}
      <meshStandardMaterial vertexColors roughness={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}
