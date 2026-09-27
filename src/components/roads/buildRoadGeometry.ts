import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TERRAIN } from "../../domain/nodeStyle";
import { junctionPieces } from "../../geo/junctions";
import {
  type ArmMarking,
  armMarking,
  crossingIntervals,
  DASH_LENGTH,
  DASH_PERIOD,
  DASH_WIDTH,
  dashStarts,
  drivewayRun,
  EDGE_INSET,
  endMargin,
  giveWayDashes,
  LANE_DASH_LENGTH,
  LANE_DASH_PERIOD,
  LINE_WIDTH,
  MARGIN_JUNCTION,
  mouthGaps,
  pavementSpans,
  ZEBRA_BAND,
  zebraOffsets,
} from "../../geo/markings";
import { arcLength, cutPolyline, offsetPolyline, pointAt, subPolyline } from "../../geo/polyline";
import { buildRoadGraph, type DeckExit, type GraphNode, type Run } from "../../geo/roadGraph";
import { CLASS_STYLE, FILLET, ISLAND_HEIGHT, PAVEMENT, ringRadii } from "../../geo/roadStyle";
import { heavier } from "../../layout/roads/segments";
import type { Driveway, RoadSegment, Roundabout, Vec2 } from "../../layout/types";
import { loopWall, polygonCap } from "../geo/polygon";
import { annulus, band, disc, paint, ribbon, ring } from "./roadPrimitives";

/** The kerb wall drops from the pavement to just under the asphalt, so its lip reads from a grazing angle. */
const KERB_BOTTOM = TERRAIN.roadY - 0.02;

/** Markings: between the asphalt and the roundabout islands, which cover them. */
const DASH_Y = TERRAIN.roadY + 0.015;

export interface RoadGeometry {
  asphalt: THREE.BufferGeometry | null;
  pavement: THREE.BufferGeometry | null;
  islands: THREE.BufferGeometry | null;
  markings: THREE.BufferGeometry | null;
  runs: Run[];
}

/** One city's road network as four merged geometries (see `RoadNetworkMesh`). */
export function buildRoadGeometry(
  segments: RoadSegment[],
  roundabouts: Roundabout[],
  driveways: Driveway[],
  exits: DeckExit[],
): RoadGeometry {
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
  // How far each arm may be cut back: most of its run, half when a node waits at the other end.
  const runLength = graph.runs.map((r) => arcLength(r.points));
  const limitsOf = (node: GraphNode) =>
    node.arms.map((a) => {
      if (a.run < 0) {
        return Infinity;
      }
      const { start, end } = graph.ends[a.run]!;
      const other = a.atStart ? end : start;
      return runLength[a.run]! * (other.arms.length >= 2 ? 0.5 : 0.8);
    });
  const reach = new Map<GraphNode, number[]>();
  const ringAngles = new Map<Roundabout, number[]>();
  for (const node of graph.nodes) {
    const pieces = junctionPieces(node, PAVEMENT, FILLET, limitsOf(node), (k, t) => {
      const arm = node.arms[k]!;
      if (arm.run < 0) {
        return null;
      }
      const points = graph.runs[arm.run]!.points;
      return pointAt(arm.atStart ? points : [...points].reverse(), t);
    });
    reach.set(node, pieces.reach);
    if (node.roundabout && pieces.ring) {
      ringAngles.set(node.roundabout, pieces.ring);
    }
    for (const apron of pieces.aprons) {
      const cap = polygonCap(apron.points, y);
      push(asphaltParts, cap && paint(cap, CLASS_STYLE[node.arms[apron.arm]!.klass].color));
    }
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
    const armIndex = (node: GraphNode, atStart: boolean) =>
      node.arms.findIndex((a) => a.run === i && a.atStart === atStart);
    const cutAt = (node: GraphNode, atStart: boolean) => {
      const k = armIndex(node, atStart);
      return k < 0 ? 0 : reach.get(node)![k]!;
    };
    const markStart = armMarking(start, start.arms[armIndex(start, true)]);
    const markEnd = armMarking(end, end.arms[armIndex(end, false)]);
    const cut = cutPolyline(run.points, cutAt(start, true), cutAt(end, false));
    if (cut.length < 2) {
      return;
    }
    const style = CLASS_STYLE[run.klass];
    const h = run.halfWidth;
    const length = arcLength(cut);
    push(asphaltParts, paint(ribbon(cut, h * 2, y)!, style.color));

    // Pavement bands, one each side, opened at every driveway mouth on that side.
    const gaps = mouthGaps(cut, driveways);
    for (const side of [-1, 1] as const) {
      for (const [a, b] of pavementSpans(gaps[side > 0 ? 1 : 0]!, length)) {
        const sub = subPolyline(cut, a, b);
        slab(offsetPolyline(sub, side * h), offsetPolyline(sub, side * (h + PAVEMENT)));
      }
    }

    // Markings on the centre: clear of the ends, patterns centred on the run.
    const marginStart = endMargin(markStart);
    const marginEnd = endMargin(markEnd);
    const dashes = (offset: number, dash: number, period: number) => {
      for (const t0 of dashStarts(length, marginStart, marginEnd, dash, period)) {
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
    const crossing = (from: number, sign: number, incoming: number, marking: ArmMarking) => {
      const { zebra, stop } = crossingIntervals(from, sign);
      const lane = subPolyline(cut, stop[0], stop[1]);
      if (marking === "giveWay") {
        // A spur meeting the ring road: dashed give-way line, no zebra across the ring.
        for (const [d0, d1] of giveWayDashes(incoming * (h - EDGE_INSET), incoming * LINE_WIDTH)) {
          push(markParts, band(lane, d0, d1, DASH_Y));
        }
        return;
      }
      for (const d of zebraOffsets(h)) {
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
      push(markParts, band(lane, incoming * (h - EDGE_INSET), incoming * LINE_WIDTH, DASH_Y));
    };
    if (markStart !== "none" && length > MARGIN_JUNCTION) {
      crossing(0, 1, 1, markStart);
    }
    if (markEnd !== "none" && length > MARGIN_JUNCTION) {
      crossing(length, -1, -1, markEnd);
    }
  });

  // Driveways: straight from the street's edge to the door. No pavement: a kerb cut is not a street.
  for (const d of driveways) {
    const run = drivewayRun(d);
    if (!run) {
      continue;
    }
    push(asphaltParts, paint(ribbon(run, TERRAIN.drivewayWidth, y)!, TERRAIN.roadColor));
  }

  for (const r of roundabouts) {
    const { inner, outer } = ringRadii(r);
    const angles = ringAngles.get(r);
    const tarmac = angles
      ? annulus(inner, outer, y, r.center, angles)
      : ring(inner, outer, y, r.center);
    asphaltParts.push(paint(tarmac, CLASS_STYLE[r.klass].color));

    // Planted centre: a low kerbed disc, not a hole cut in the tarmac.
    const wall = new THREE.CylinderGeometry(inner, inner, ISLAND_HEIGHT, 24, 1, true);
    wall.translate(r.center[0], y + ISLAND_HEIGHT / 2, r.center[1]);
    islandParts.push(paint(wall, TERRAIN.islandSide));
    islandParts.push(paint(disc(inner, y + ISLAND_HEIGHT, r.center, 24), TERRAIN.roundaboutIsland));

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
}
