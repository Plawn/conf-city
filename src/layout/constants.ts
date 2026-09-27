import { NODE_STYLE } from "../domain/nodeStyle";
import type { NodeType } from "../domain/types";
import { CLASS_STYLE, FILLET, PAVEMENT, ROUNDABOUT_RADII, ringRadii } from "../geo/roadStyle";

/**
 * Geometry constants shared by the whole layout pipeline.
 *
 * Everything snaps to a lattice of pitch `PITCH`: buildings sit exactly on
 * `(i·PITCH, j·PITCH)`, road corners exactly on `((i+0.5)·PITCH, (j+0.5)·PITCH)`.
 * Both are exact float values, which is what lets `roads/`, `drivable.ts` and
 * `bridges.ts` match route points to roundabouts and bridgeheads by value.
 */

/** Lattice step: one building per cell, so two buildings are never closer than this. */
export const PITCH = 6;
/** Distance from a cell centre to the road corners around it, on each axis. */
export const ROAD_OFFSET = PITCH / 2;
/**
 * Minimum distance between two roundabout centres. Two cells: at one cell the
 * rings of two boulevard roundabouts (outer ≈ 2.8 plus kerb) nearly touch, and a
 * block where every corner is a roundabout reads as a mess rather than a city.
 */
export const ROUNDABOUT_SPACING = PITCH * 2;
/**
 * Distance from the hull of the footprints to the centreline of the ring road.
 * With 4.0 every lattice corner of an occupied cell lies inside the ring, and a
 * street on a corner of the hull's straight sides (`3 − r_min = 1.92` from the
 * hull) keeps its pavement clear of the ring's (`4 − 1.1 − 0.85 ≈ 2.0`).
 */
export const RING_PADDING = 4;
const half = (klass: keyof typeof CLASS_STYLE) => CLASS_STYLE[klass].width / 2;
/** Outer tarmac radius of a roundabout of `klass`. */
const outerOf = (klass: keyof typeof CLASS_STYLE) =>
  ringRadii({ center: [0, 0], radius: ROUNDABOUT_RADII[klass], klass }).outer;
/** How far a street's crossroads eats into its arms: half a street plus the kerb fillet. */
const STREET_REACH = half("street") + FILLET;
/**
 * Minimum distance between a lattice corner the A* may use and the ring's
 * centreline: the ring avenue and a street, each with its pavement, side by
 * side without their kerbs touching. Corners closer than this (typically the
 * diagonal corner of a building at a hull vertex) are simply not part of the grid.
 */
export const RING_CLEARANCE = half("avenue") + PAVEMENT + half("street") + PAVEMENT;
/**
 * Minimum distance between a ring roundabout and anything else joining the ring
 * — the lattice corner its stub leaves from, another street's T, a driveway
 * mouth: its outer tarmac and pavement, plus a street crossroads' reach.
 */
export const RING_ROUNDABOUT_CLEAR = outerOf("avenue") + PAVEMENT + STREET_REACH;
/** Shortest stub a street may join the ring by: both ends' junction reach, never touching. */
export const RING_STUB_MIN = half("avenue") + FILLET + STREET_REACH;
/** Two bridgehead roundabouts on one ring keep their tarmac and pavements apart. */
export const BRIDGEHEAD_SPACING = 2 * RING_ROUNDABOUT_CLEAR;
/** A lattice roundabout keeps its widest ring and pavement clear of the ring road's. */
export const LATTICE_ROUNDABOUT_CLEAR = outerOf("boulevard") + PAVEMENT + half("avenue") + PAVEMENT;
/** How far the island shore is pushed beyond the buildings' footprints (2.0 past the ring). */
export const ISLAND_PADDING = RING_PADDING + 2;
/** Padding of a neighbourhood slab around its members. */
export const GROUP_PADDING = 1.8;
/** Padding of the discovery district's slab (looser: it grows at runtime). */
export const DISCOVERY_PADDING = 2.4;
/** Minimum water between two island shores (hard constraint of the city placement). */
export const WATER_GAP = 18;
/**
 * Water reserved off an island that has a port: the berths sit on the shore and
 * their ships moor a few units out. Added to the island's collision radius
 * *before* the islands are placed, so a quay never eats into `WATER_GAP`.
 */
export const HARBOUR_REACH = 6;
/**
 * Rest length of a spring standing for one intra-city link. Two cells, not one:
 * at a shorter rest length linked buildings settle on *diagonally* adjacent
 * cells, which share a single corner and therefore need no street at all — the
 * road network comes out empty.
 */
export const LINK_REST = PITCH * 2;
/** Relaxation budget — the layout is deterministic, so this is a pure quality knob. */
export const FORCE_ITERATIONS = 250;

/**
 * Radius of the ground footprint of a building, used for collisions and for the
 * island outline. Capped so a `cache` (scale 2) does not dominate the shore.
 */
export function footprintRadius(type: NodeType): number {
  return Math.min(NODE_STYLE[type].scale * 0.9, 1.8);
}
