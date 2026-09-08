import type { BiomeId } from "../domain/biome";
import type { PositionedNode, ResolvedLink } from "../domain/types";
import type { CityBounds } from "./bounds";
import type { HarbourSite } from "./harbour";

/**
 * The data contract between the layout (pure TS) and the renderer.
 *
 * Everything here is in **world** coordinates: `layoutWorld` translates the
 * local artefacts produced per city by the island offset before exposing them.
 */

/** A point on the ground plane, `[x, z]` — the Y axis is the renderer's business. */
export type Vec2 = [number, number];

/**
 * How much traffic a stretch of road carries, i.e. how many routes share it.
 * The layout only says *what* a road is; the renderer decides how wide and how
 * pale that makes it (`CLASS_STYLE` in `components/geo/roadStyle.ts`).
 */
export type RoadClass = "street" | "avenue" | "boulevard";

/**
 * One stretch of road as a polyline — straight on the lattice, curved for the
 * ring — cut at every junction (three or more directions), roundabout and
 * class change, so a single segment has one width from end to end and its two
 * ends are graph nodes the renderer can build junctions from. Ring pieces are
 * flagged: they are never fused with a neighbour into a closed loop.
 */
export interface RoadSegment {
  points: Vec2[];
  klass: RoadClass;
  ring?: true;
}

/** A junction where 3+ directions meet: drawn as a roundabout. */
export interface Roundabout {
  center: Vec2;
  radius: number;
  klass: RoadClass;
}

/**
 * The drivable path of one link: building centre → driveway mouth → road
 * corners → driveway mouth → building centre. A feeder to a bridge ends on the
 * bridgehead, a vertex of the ring; a building with no link gets a `ring:<id>`
 * route straight from its door to the ring. Every corner in it is a junction
 * centre, matched against roundabouts by exact coordinate equality — never
 * round-trip route points through float math.
 */
export interface RoadRoute {
  points: Vec2[];
}

/**
 * The short lane between a building and the street it fronts: from the middle
 * of a street edge running along the plot (`mouth`, on the street's centreline)
 * straight to the building (`door`, just outside its footprint). `klass` is the
 * street it opens onto, so the renderer can butt the lane against its edge. A
 * building with no link has a longer one, straight out to the ring (an avenue).
 */
export interface Driveway {
  mouth: Vec2;
  door: Vec2;
  klass: RoadClass;
}

export interface RoadNetwork {
  segments: RoadSegment[];
  roundabouts: Roundabout[];
  driveways: Driveway[];
  /** The ring road: closed loop (last ≠ first), attach vertices included. */
  ring: Vec2[];
  /** Keyed by `linkKey(link)`, or `ring:<nodeId>` for a building's own way to the ring. */
  routes: Map<string, RoadRoute>;
}

/** Stable identity of a link, used to key routes and bridges. */
export function linkKey(l: ResolvedLink): string {
  return `${l.fromCityId}/${l.fromNodeId}->${l.toCityId}/${l.toNodeId}`;
}

/** A neighbourhood (or the discovery district): a closed polygon plus its label anchor. */
export interface GroupZone {
  name: string;
  outline: Vec2[];
  center: Vec2;
}

/**
 * One installation's ground: a point on the waterfront, facing the open sea.
 * The renderer takes it as given — it never picks a spot of its own.
 */
export interface UtilitySlot {
  /** Middle of the band, halfway between the ring's kerb and the beach. */
  center: Vec2;
  /** Yaw putting a model's −Z face toward the water. */
  yaw: number;
  /** Unit normal from the slot to the water — the seaward side of the ring road. */
  shoreward: Vec2;
  /** Depth of the buildable band here, from the ring's kerb to the beach. */
  room: number;
}

/**
 * The stretch of seafront reserved for the island's utility district: the
 * lighthouse and the machine gauges built along it (`layout/utilityPlot.ts`).
 * Outside the ring road, on the island's widest headland, facing the open sea —
 * the district is laid out along the tangent, the way a waterfront is.
 */
export interface UtilityPlot {
  /** Middle of the waterfront. */
  center: Vec2;
  /** Yaw putting a model's −Z face toward the water, at `center`. */
  yaw: number;
  /** Unit normal from the plot to the water, at `center`. */
  shoreward: Vec2;
  /** Depth of the buildable band at `center`. */
  room: number;
  /** Length of the waterfront along the shore. */
  span: number;
  /**
   * What the district's models must be multiplied by to fit the land there —
   * 1 on an island with room to spare, less on a cramped one.
   */
  scale: number;
  /**
   * The installations' grounds, in a fixed order along the shore: lighthouse,
   * power station, water tower, container quay. Always `SLOT_COUNT` of them.
   */
  slots: UtilitySlot[];
}

export interface CityLayout {
  cityId: string;
  /** Resolved once in the domain; the layout shaped the shore with it, the renderer paints with it. */
  biome: BiomeId;
  nodes: PositionedNode[];
  center: Vec2;
  /** Closed polygon (world coords) — the shape of the island. */
  outline: Vec2[];
  /** AABB of the outline — camera fit. */
  bounds: CityBounds;
  roads: RoadNetwork;
  groups: GroupZone[];
  discoveredZone?: GroupZone;
  /** The quay of the ingress services, when this island has any. */
  harbour?: HarbourSite;
  /** Where the machine gauges stand. Absent on an island with no free land. */
  utilityPlot?: UtilityPlot;
}

/**
 * One inter-city link riding a shared bridge: the full drivable path goes
 * source building → feeder streets → bridgehead → deck → bridgehead → streets
 * → target building. `waterSpan` is the deck segment inside `points`, oriented
 * in the direction of travel — built from the same lattice arithmetic as the
 * points, so it is matched by exact coordinate equality.
 */
export interface BridgeCrossing {
  link: ResolvedLink;
  /** `linkKey(link)`. */
  key: string;
  points: Vec2[];
  waterSpan: [Vec2, Vec2];
}

/**
 * One bridge per pair of linked cities — the way it would be built for real:
 * every link between the two islands merges onto a single deck, reached
 * through feeder streets routed on each island's own road network.
 */
export interface Bridge {
  /** `"cityA|cityB"`, cities in lexical order. */
  key: string;
  cityA: string;
  cityB: string;
  /** The two bridgeheads, `[cityA's, cityB's]` — vertices of each ring, not deck ends. */
  waterSpan: [Vec2, Vec2];
  crossings: BridgeCrossing[];
}

export interface WorldLayout {
  /** Flat list in world coordinates — the array every consumer already uses. */
  nodes: PositionedNode[];
  cities: Map<string, CityLayout>;
  bridges: Bridge[];
}
