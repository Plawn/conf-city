import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TERRAIN } from "../domain/nodeStyle";
import { junctionPieces } from "../geo/junctions";
import {
  arcLength,
  cutPolyline,
  offsetPolyline,
  projectOnPolyline,
  subPolyline,
} from "../geo/polyline";
import { buildRoadGraph, type DeckExit, type GraphNode, ON_LINE } from "../geo/roadGraph";
import { CLASS_STYLE, FILLET, ISLAND_HEIGHT, PAVEMENT, ringRadii } from "../geo/roadStyle";
import { heavier } from "../layout/roads/segments";
import type { Driveway, RoadSegment, Roundabout, Vec2 } from "../layout/types";
import { loopWall, polygonCap } from "./geo/polygon";
import { buildRibbon } from "./geo/ribbon";
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
 * colour, rather than one mesh per shade.
 */

/** The kerb wall drops from the pavement to just under the asphalt, so its lip reads from a grazing angle. */
const KERB_BOTTOM = TERRAIN.roadY - 0.02;

/** Markings: between the asphalt and the roundabout islands, which cover them. */
const DASH_Y = TERRAIN.roadY + 0.015;
const DASH_WIDTH = 0.1;
const DASH_LENGTH = 0.5;
const DASH_PERIOD = 1.3;
const LANE_DASH_LENGTH = 0.3;
const LANE_DASH_PERIOD = 0.9;
const LINE_WIDTH = 0.06;
/** Edge lines sit this far inside the asphalt edge. */
const EDGE_INSET = 0.12;
/** Centre markings stay clear of the ends: a plain end, or a crossing with its zebra and stop line. */
const MARGIN_PLAIN = 0.5;
const MARGIN_JUNCTION = 1.3;
const ZEBRA_FROM = 0.25;
const ZEBRA_TO = 0.75;
const ZEBRA_STEP = 0.2;
const ZEBRA_BAND = 0.12;
const STOP_AT = 0.9;
const STOP_WIDTH = 0.12;
/** Half the pavement gap at a driveway mouth: the driveway plus a kerb drop each side. */
const MOUTH_GAP = TERRAIN.drivewayWidth / 2 + 0.1;
/** A stable empty default: a fresh `[]` per render would rebuild the whole network every frame. */
const NO_EXITS: DeckExit[] = [];

type Vec3 = [number, number, number];

/** Paints a flat colour into a `color` attribute, so parts of different shades merge. */
function paint(geometry: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
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

function disc(radius: number, y: number, center: Vec2, segments = 16): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(radius, segments);
  g.rotateX(-Math.PI / 2);
  g.translate(center[0], y, center[1]);
  return g;
}

function ring(inner: number, outer: number, y: number, center: Vec2): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(inner, outer, 28);
  g.rotateX(-Math.PI / 2);
  g.translate(center[0], y, center[1]);
  return g;
}

const lift = (points: Vec2[], y: number): Vec3[] => points.map(([x, z]) => [x, y, z]);

/** A ribbon along the polyline, at height `y`; `null` when there is nothing to draw. */
function ribbon(points: Vec2[], width: number, y: number): THREE.BufferGeometry | null {
  if (points.length < 2) {
    return null;
  }
  return buildRibbon(lift(points, y), width);
}

/** The band between lateral offsets `d0` and `d1` of the polyline (right is positive). */
function band(points: Vec2[], d0: number, d1: number, y: number): THREE.BufferGeometry | null {
  if (points.length < 2) {
    return null;
  }
  return ribbon(offsetPolyline(points, (d0 + d1) / 2), Math.abs(d1 - d0), y);
}

/** A crossing that gets a zebra and a stop line on every arm. */
const isCrossing = (node: GraphNode) => node.kind === "junction" && node.arms.length >= 3;

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
  const { asphalt, pavement, islands, markings, runs } = useMemo(() => {
    const y = TERRAIN.roadY;
    const asphaltParts: THREE.BufferGeometry[] = [];
    const pavementParts: THREE.BufferGeometry[] = [];
    const islandParts: THREE.BufferGeometry[] = [];
    const markParts: THREE.BufferGeometry[] = [];
    const push = (list: THREE.BufferGeometry[], g: THREE.BufferGeometry | null) => {
      if (g) {
        list.push(g);
      }
    };

    /** A pavement piece: its top, and the kerb wall all around it. */
    const slab = (inner: Vec2[], outer: Vec2[]) => {
      const loop = [...inner, ...[...outer].reverse()];
      const cap = polygonCap(loop, TERRAIN.pavementY);
      if (cap) {
        pavementParts.push(paint(cap, TERRAIN.pavement));
      }
      const wall = loopWall(loop, KERB_BOTTOM, TERRAIN.pavementY, true);
      if (wall) {
        pavementParts.push(paint(wall, TERRAIN.kerbColor));
      }
    };

    const graph = buildRoadGraph(
      segments,
      roundabouts,
      driveways.map((d) => d.mouth),
      exits,
    );

    // Nodes: the cut on every arm, the asphalt cap and the pavement corners.
    const reach = new Map<GraphNode, number[]>();
    for (const node of graph.nodes) {
      const pieces = junctionPieces(node, PAVEMENT, FILLET);
      reach.set(node, pieces.reach);
      if (pieces.asphalt) {
        const klass = node.arms.map((a) => a.klass).reduce(heavier);
        push(
          asphaltParts,
          pieces.asphalt.length >= 3
            ? paint(polygonCap(pieces.asphalt, y)!, CLASS_STYLE[klass].color)
            : null,
        );
      }
      for (const piece of pieces.pavements) {
        slab(piece.inner, piece.outer);
      }
    }

    // Runs: what is left between two nodes.
    graph.runs.forEach((run, i) => {
      const { start, end } = graph.ends[i]!;
      const cutAt = (node: GraphNode, atStart: boolean) => {
        const k = node.arms.findIndex((a) => a.run === i && a.atStart === atStart);
        return k < 0 ? 0 : reach.get(node)![k]!;
      };
      const cut = cutPolyline(run.points, cutAt(start, true), cutAt(end, false));
      if (cut.length < 2) {
        return;
      }
      const style = CLASS_STYLE[run.klass];
      const h = run.halfWidth;
      const length = arcLength(cut);
      push(asphaltParts, paint(ribbon(cut, h * 2, y)!, style.color));

      // Pavement bands, one each side, opened at every driveway mouth on that side.
      const gaps: [number, number][][] = [[], []];
      for (const d of driveways) {
        const hit = projectOnPolyline(cut, d.mouth);
        if (hit.dist > ON_LINE) {
          continue;
        }
        const side = projectOnPolyline(cut, d.door).side > 0 ? 1 : 0;
        gaps[side]!.push([hit.t - MOUTH_GAP, hit.t + MOUTH_GAP]);
      }
      for (const side of [-1, 1] as const) {
        const holes = gaps[side > 0 ? 1 : 0]!.sort((a, b) => a[0] - b[0]);
        let from = 0;
        const spans: [number, number][] = [];
        for (const [a, b] of holes) {
          if (a > from) {
            spans.push([from, a]);
          }
          from = Math.max(from, b);
        }
        if (from < length) {
          spans.push([from, length]);
        }
        for (const [a, b] of spans) {
          if (b - a < 0.05) {
            continue;
          }
          const sub = subPolyline(cut, a, b);
          slab(offsetPolyline(sub, side * h), offsetPolyline(sub, side * (h + PAVEMENT)));
        }
      }

      // Markings on the centre: clear of the ends, patterns centred on the run.
      const marginStart = isCrossing(start) ? MARGIN_JUNCTION : MARGIN_PLAIN;
      const marginEnd = isCrossing(end) ? MARGIN_JUNCTION : MARGIN_PLAIN;
      const dashes = (offset: number, dash: number, period: number) => {
        const usable = length - marginStart - marginEnd;
        if (usable < dash) {
          return;
        }
        const gap = period - dash;
        const count = Math.floor((usable + gap) / period);
        const first = marginStart + (usable - (count * period - gap)) / 2;
        for (let k = 0; k < count; k++) {
          const t0 = first + k * period;
          push(
            markParts,
            band(
              subPolyline(cut, t0, t0 + dash),
              offset - DASH_WIDTH / 2,
              offset + DASH_WIDTH / 2,
              DASH_Y,
            ),
          );
        }
      };
      const line = (offset: number, t0: number, t1: number, width = LINE_WIDTH) =>
        push(
          markParts,
          band(subPolyline(cut, t0, t1), offset - width / 2, offset + width / 2, DASH_Y),
        );

      if (style.lanes >= 2) {
        // Two lanes each way: a double centre line, and dashes between the lanes.
        line(-LINE_WIDTH, marginStart, length - marginEnd);
        line(LINE_WIDTH, marginStart, length - marginEnd);
        dashes(-h / 2, LANE_DASH_LENGTH, LANE_DASH_PERIOD);
        dashes(h / 2, LANE_DASH_LENGTH, LANE_DASH_PERIOD);
      } else {
        dashes(0, DASH_LENGTH, DASH_PERIOD);
      }
      if (style.edgeLines) {
        line(-(h - EDGE_INSET), 0.1, length - 0.1);
        line(h - EDGE_INSET, 0.1, length - 0.1);
      }

      // Crossing arms: a zebra, then a stop line across the lane heading in.
      // Vehicles keep to their own right, which `TrafficSystem` computes as
      // `(-dz, dx)` — the *negative* side of `offsetPolyline`. So the lane
      // heading into the end node sits at a negative offset, and the one heading
      // back into the start node at a positive one.
      const crossing = (from: number, sign: number, incoming: number) => {
        const zebra: [number, number] =
          sign > 0 ? [from + ZEBRA_FROM, from + ZEBRA_TO] : [from - ZEBRA_TO, from - ZEBRA_FROM];
        for (let d = -h + EDGE_INSET; d <= h - EDGE_INSET + 1e-6; d += ZEBRA_STEP) {
          push(
            markParts,
            band(
              subPolyline(cut, zebra[0], zebra[1]),
              d - ZEBRA_BAND / 2,
              d + ZEBRA_BAND / 2,
              DASH_Y,
            ),
          );
        }
        const stop: [number, number] =
          sign > 0
            ? [from + STOP_AT, from + STOP_AT + STOP_WIDTH]
            : [from - STOP_AT - STOP_WIDTH, from - STOP_AT];
        push(
          markParts,
          band(
            subPolyline(cut, stop[0], stop[1]),
            incoming * (h - EDGE_INSET),
            incoming * LINE_WIDTH,
            DASH_Y,
          ),
        );
      };
      if (isCrossing(start) && length > MARGIN_JUNCTION) {
        crossing(0, 1, 1);
      }
      if (isCrossing(end) && length > MARGIN_JUNCTION) {
        crossing(length, -1, -1);
      }
    });

    // A driveway butts against the edge of the street it opens onto — it starts
    // half the street's width out from the mouth, which is on the centreline —
    // and runs straight to the door. No pavement: a kerb cut is not a street.
    for (const d of driveways) {
      const dx = d.door[0] - d.mouth[0];
      const dz = d.door[1] - d.mouth[1];
      const length = Math.hypot(dx, dz);
      const setback = CLASS_STYLE[d.klass].width / 2;
      if (length <= setback) {
        continue;
      }
      const from: Vec2 = [
        d.mouth[0] + (dx / length) * setback,
        d.mouth[1] + (dz / length) * setback,
      ];
      push(
        asphaltParts,
        paint(ribbon([from, d.door], TERRAIN.drivewayWidth, y)!, TERRAIN.roadColor),
      );
    }

    for (const r of roundabouts) {
      const { inner, outer } = ringRadii(r);
      asphaltParts.push(paint(ring(inner, outer, y, r.center), CLASS_STYLE[r.klass].color));

      // Planted centre: a low kerbed disc, not a hole cut in the tarmac.
      const wall = new THREE.CylinderGeometry(inner, inner, ISLAND_HEIGHT, 24, 1, true);
      wall.translate(r.center[0], y + ISLAND_HEIGHT / 2, r.center[1]);
      islandParts.push(paint(wall, TERRAIN.islandSide));
      islandParts.push(
        paint(disc(inner, y + ISLAND_HEIGHT, r.center, 24), TERRAIN.roundaboutIsland),
      );

      // Give way: a thin painted ring on the outer edge of the tarmac.
      markParts.push(ring(outer - 0.22, outer - 0.06, DASH_Y, r.center));
    }

    const merge = (geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null => {
      if (geos.length === 0) {
        return null;
      }
      const merged = mergeGeometries(geos);
      for (const g of geos) {
        g.dispose();
      }
      return merged;
    };

    return {
      asphalt: merge(asphaltParts),
      pavement: merge(pavementParts),
      islands: merge(islandParts),
      markings: merge(markParts),
      runs: graph.runs,
    };
  }, [segments, roundabouts, driveways, exits]);

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
