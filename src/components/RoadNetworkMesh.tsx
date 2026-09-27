import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { TERRAIN } from "../domain/nodeStyle";
import type { DeckExit } from "../geo/roadGraph";
import type { Driveway, RoadSegment, Roundabout } from "../layout/types";
import { buildRoadGeometry } from "./roads/buildRoadGeometry";
import { StreetLights } from "./StreetLights";

/**
 * The whole road network of one city in four merged draw calls, built once and
 * never animated: the raised pavements (top and kerb wall), the asphalt (runs,
 * junction caps, roundabout rings, driveways), the planted roundabout islands,
 * and the painted markings.
 *
 * The layout's segments are first turned into a graph (`buildRoadGraph`): runs
 * that continue one another are fused and their bends rounded, and every node
 * gets its shape from `junctionPieces` — a filleted asphalt cap plus one
 * pavement piece per pair of arms, with the distance each run is cut back so
 * the two meet on one line. What is left of a run is a ribbon of asphalt, a
 * band of pavement each side interrupted at the driveway mouths (the kerb cut),
 * and the markings of its class: dashes on a street, edge lines on an avenue,
 * a double centre line and lane dashes on a boulevard, a zebra and a stop line
 * on every arm of a crossing.
 *
 * Everything merged into one mesh must share one attribute set — `mergeGeometries`
 * refuses a mix of indexed and non-indexed inputs, or a missing attribute.
 * `buildRibbon`, `polygonCap`, `loopWall` and the three.js primitives used here
 * are all indexed with position/normal/uv; the asphalt and pavement carry
 * several shades at once, so they get a fourth attribute, a flat per-vertex
 * colour, rather than one mesh per shade. The parts are built by
 * `roads/buildRoadGeometry.ts`, their layout by `geo/markings.ts`.
 */

/** A stable empty default: a fresh `[]` per render would rebuild the whole network every frame. */
const NO_EXITS: DeckExit[] = [];

export function RoadNetworkMesh({
  segments,
  roundabouts,
  driveways,
  exits = NO_EXITS,
}: {
  segments: RoadSegment[];
  roundabouts: Roundabout[];
  driveways: Driveway[];
  /** Bridge decks leaving this city's bridgeheads: the pavement ring opens for them. */
  exits?: DeckExit[];
}) {
  const { asphalt, pavement, islands, markings, runs } = useMemo(
    () => buildRoadGeometry(segments, roundabouts, driveways, exits),
    [segments, roundabouts, driveways, exits],
  );

  // Dispose replaced buffers before another frame can bind the new geometry
  // to the same render object (Three r185 disposal reads its current attributes).
  useLayoutEffect(() => {
    return () => {
      asphalt?.dispose();
      pavement?.dispose();
      islands?.dispose();
      markings?.dispose();
    };
  }, [asphalt, pavement, islands, markings]);

  if (!asphalt && !pavement && !islands && !markings) {
    return null;
  }

  return (
    <group>
      {pavement && (
        <mesh
          matrixAutoUpdate={false}
          onUpdate={(mesh) => mesh.updateMatrix()}
          geometry={pavement}
          receiveShadow
        >
          <meshStandardMaterial
            vertexColors
            roughness={0.9}
            metalness={0.05}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {asphalt && (
        <mesh
          matrixAutoUpdate={false}
          onUpdate={(mesh) => mesh.updateMatrix()}
          geometry={asphalt}
          receiveShadow
        >
          <meshStandardMaterial
            vertexColors
            roughness={0.95}
            metalness={0.05}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}
      {islands && (
        <mesh
          matrixAutoUpdate={false}
          onUpdate={(mesh) => mesh.updateMatrix()}
          geometry={islands}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial vertexColors roughness={0.95} metalness={0.05} />
        </mesh>
      )}
      {markings && (
        // Unlit: a painted marking should not dim with the road it sits on. The
        // roundabout islands are opaque and higher, so the depth test alone clips
        // the stripes there — nothing here needs to know about them.
        <mesh matrixAutoUpdate={false} onUpdate={(mesh) => mesh.updateMatrix()} geometry={markings}>
          <meshBasicMaterial
            color={TERRAIN.roadDash}
            transparent
            opacity={0.6}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
          />
        </mesh>
      )}
      <StreetLights runs={runs} roundabouts={roundabouts} />
    </group>
  );
}
