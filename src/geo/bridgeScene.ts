import type { Infrastructure } from "../domain/mobility";
import { TERRAIN } from "../domain/nodeStyle";
import { buildShoreField, type ShoreField } from "../layout/shore";
import type { Bridge, BridgeCrossing, RoadClass, Vec2, WorldLayout } from "../layout/types";
import { bridgeDeck, type DrivePath, deckClass, deckWidth, makeDriver } from "./drivable";
import type { DeckExit } from "./roadGraph";

/** What `WorldScene` derives from the layout for its bridges, extent and shore: pure, memoised there. */

/** Half-size of the shadow frustum for a small world. */
const MIN_EXTENT = 60;
/** Breathing room around the outermost shore. */
const EXTENT_MARGIN = 12;
/** Hover ribbons ride above the deck so they win the raycast against the bridge. */
const BRIDGE_OVERLAY_LIFT = 0.04;

export interface VisibleBridge {
  bridge: Bridge;
  klass: RoadClass;
  deck: [Vec2, Vec2];
  crossings: { crossing: BridgeCrossing; path: DrivePath }[];
}

export interface BridgeOverlay {
  crossing: BridgeCrossing;
  points: [number, number, number][];
}

// Where a deck leaves each city: the bridgehead pavement opens there. Keyed by
// city so every `CityScene` gets a stable array and only rebuilds its roads
// when the bridges do. A widened bridge needs a wider mouth, so the opening
// is taken from the same deck class the mesh and the traffic use.
export function deckExits(
  layout: WorldLayout | undefined,
  infra: Infrastructure,
): Map<string, DeckExit[]> {
  const out = new Map<string, DeckExit[]>();
  if (!layout) {
    return out;
  }
  for (const b of layout.bridges) {
    const [a, c] = b.waterSpan;
    const klass = deckClass(infra.bridges[b.key]);
    const halfWidth = deckWidth(klass) / 2;
    const add = (city: string, exit: DeckExit) => out.set(city, [...(out.get(city) ?? []), exit]);
    add(b.cityA, { at: a, toward: c, halfWidth, klass });
    add(b.cityB, { at: c, toward: a, halfWidth, klass });
  }
  return out;
}

// Inter-city bridges: one deck per pair of visible cities. Each link crossing
// it keeps its own full drivable path (feeder streets + deck), elevated once
// here and reused by the hover overlay and the traffic, so they agree.
export function visibleBridges(
  layout: WorldLayout | undefined,
  visibleCities: Set<string>,
  infra: Infrastructure,
): VisibleBridge[] {
  if (!layout) {
    return [];
  }
  // A crossing runs over both islands' street grids, so it can meet a roundabout
  // on either shore — the bridgeheads included, which the driver circles up to
  // the deck's bearing — and its lanes come from either city's roads.
  const networks = [...layout.cities.values()].map((c) => c.roads);
  const roundabouts = networks.flatMap((n) => n.roundabouts);
  const driver = makeDriver(networks);
  return layout.bridges
    .filter((b) => visibleCities.has(b.cityA) && visibleCities.has(b.cityB))
    .map((bridge) => {
      const klass = deckClass(infra.bridges[bridge.key]);
      return {
        bridge,
        klass,
        deck: bridgeDeck(bridge.waterSpan, roundabouts),
        crossings: bridge.crossings.map((crossing) => ({
          crossing,
          path: driver.crossing(crossing.points, crossing.waterSpan, klass),
        })),
      };
    });
}

/** Every crossing's path, lifted just above its deck for the hover ribbon. */
export function bridgeOverlays(bridges: VisibleBridge[]): BridgeOverlay[] {
  return bridges.flatMap(({ crossings }) =>
    crossings.map(({ crossing, path }) => ({
      crossing,
      points: path.points.map(
        ([x, y, z]) => [x, y + BRIDGE_OVERLAY_LIFT, z] as [number, number, number],
      ),
    })),
  );
}

// How far the world spreads: the shadow frustum, the fog and the far plane all
// follow it instead of the hard-coded ±60 that only fitted a single row of cities.
export function worldExtent(layout: WorldLayout | undefined): number {
  let half = 0;
  for (const c of layout?.cities.values() ?? []) {
    half = Math.max(
      half,
      Math.abs(c.bounds.cx) + c.bounds.width / 2,
      Math.abs(c.bounds.cz) + c.bounds.height / 2,
    );
  }
  return Math.max(MIN_EXTENT, half + EXTENT_MARGIN);
}

// The coastline the sea shades against. Hidden cities render nothing, so they
// must leave no ghost shore either.
export function visibleShore(
  layout: WorldLayout | undefined,
  visibleCities: Set<string>,
): ShoreField | undefined {
  if (!layout) {
    return undefined;
  }
  const outlines = [...layout.cities.values()]
    .filter((c) => visibleCities.has(c.cityId))
    .map((c) => c.outline);
  return outlines.length > 0 ? buildShoreField(outlines, TERRAIN.shoreReach) : undefined;
}
