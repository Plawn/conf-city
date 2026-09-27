import { PITCH } from "./constants";
import { cellKey, distToPolygon, pointInPolygon, polygonBounds, segSegIntersect } from "./geometry";
import type { Vec2 } from "./types";

/**
 * Where an **ingress** service stands: not a building in the block with a jetty
 * bolted on somewhere else, but the port itself, on the coast.
 *
 * The shore and the ring road are two offsets of the same hull of the building
 * footprints (`outline.ts`, `ringRoad.ts`), so a node dragged seaward would just
 * push the coast in front of it and never reach the water. Ingress nodes are
 * therefore kept **out** of `layoutCity` — out of the hull — and dropped back
 * afterwards, here, on the shoreline the other buildings produced.
 *
 * A berth is a plain lattice cell, `(i·PITCH, j·PITCH)`, exactly like any other
 * building: `roads/` addresses a building by `cellCentre(cell)`, so anything
 * off-lattice would leave its driveway ending a few units short of the quay.
 * The cells that qualify are the ones *outside* the ring road and *inside* the
 * coast — the two-unit strip the ring leaves between itself and the sea, which
 * is exactly where a quay belongs. Being outside the ring, such a cell has no
 * usable lattice corner, so `buildRoadNetwork` falls back on its existing
 * "building nobody serves" path and opens an avenue from the quay to the ring.
 *
 * Several ingress services on one island share one quay: the first one anchors
 * it, the others take the nearest free cells along the same stretch of coast.
 *
 * Everything here is pure and deterministic: candidates are enumerated in
 * lattice order and every tie is broken on the cell indices.
 */

/** How far off the quay a ship comes to rest. */
const BERTH_REACH = 3;
/** Half-width of the corridor a ship needs, tested against every shore. */
const LANE_HALF_WIDTH = 0.7;
/** A berth further than this from the anchor is a second port, not a second berth. */
const QUAY_SPREAD = PITCH * 2.5;

export interface Berth {
  /** `cityId/nodeId` — what the fleet matches telemetry on. */
  address: string;
  nodeId: string;
  cell: [number, number];
  /** Cell centre: the node's own position, and what `roads/` routes to. */
  position: Vec2;
  /** Yaw putting the model's −Z face toward the open sea. */
  bearing: number;
  /** Mooring point, in the water, in front of the berth. */
  dock: Vec2;
}

export interface HarbourSite {
  cityId: string;
  /** Centre of the quay — the first berth. */
  quay: Vec2;
  /** Yaw of the quay as a whole (the anchor berth's). */
  bearing: number;
  berths: Berth[];
  /**
   * Where a ship enters the sea lane, far offshore, or `null` when no straight
   * lane reaches this coast without crossing another island: the port is built,
   * it just never sees a ship.
   */
  outside: Vec2 | null;
}

export interface HarbourRequest {
  cityId: string;
  /** Local coordinates, as produced by `buildLocalCity`. */
  outline: Vec2[];
  ring: Vec2[];
  /** Cells already taken by ordinary buildings. */
  taken: ReadonlySet<string>;
  /** Ingress services of this city, in a stable order. */
  ingress: { nodeId: string; address: string }[];
  /** Island offset: `world = local + offset`. */
  offset: Vec2;
  /** Every island's shore, in **world** coordinates — what a sea lane must miss. */
  islands: Vec2[][];
}

/**
 * True when the straight corridor `from → to`, widened by `LANE_HALF_WIDTH` on
 * each side, touches no island: a ship can sail it without running aground.
 */
function seaLane(from: Vec2, to: Vec2, islands: Vec2[][]): boolean {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) {
    return false;
  }
  return [-LANE_HALF_WIDTH, 0, LANE_HALF_WIDTH].every((offset) => {
    const a: Vec2 = [from[0] - (dz / length) * offset, from[1] + (dx / length) * offset];
    const b: Vec2 = [to[0] - (dz / length) * offset, to[1] + (dx / length) * offset];
    return islands.every(
      (island) =>
        !pointInPolygon(a, island) &&
        !island.some((p, i) => segSegIntersect(a, b, p, island[(i + 1) % island.length]!) !== null),
    );
  });
}

interface Candidate {
  cell: [number, number];
  /** Local cell centre. */
  centre: Vec2;
  /** Outward unit normal, away from the middle of the island. */
  normal: Vec2;
  /** Distance from the cell centre to the shoreline. */
  shore: number;
  /** Inside the ring road: a fallback site, not a quay. */
  inRing: boolean;
}

/**
 * Chooses the quay and its berths for one city. Returns `null` when the island
 * has no free cell at all inside its shore — nothing to build a port on.
 *
 * The site is returned in **local** coordinates; `translateHarbour` moves it to
 * the world with the island's integer offset, the same arithmetic every other
 * layout artefact goes through, so exact coordinate equality survives.
 */
export function planHarbour(req: HarbourRequest): HarbourSite | null {
  if (req.ingress.length === 0 || req.outline.length < 3) {
    return null;
  }
  const candidates = coastalCells(req);
  if (candidates.length === 0) {
    return null;
  }

  const [ox, oz] = req.offset;
  const reach = seaReach(req.islands);
  const laneOf = (c: Candidate): Vec2 | null => {
    const dock = mooring(c);
    const from: Vec2 = [dock[0] + ox, dock[1] + oz];
    const to: Vec2 = [from[0] + c.normal[0] * reach, from[1] + c.normal[1] * reach];
    return seaLane(from, to, req.islands) ? [to[0] - ox, to[1] - oz] : null;
  };

  // The anchor is the best coastal cell a ship can actually reach; if none can,
  // the best cell overall still gets the port, just without a lane.
  let anchor = candidates[0]!;
  let outside: Vec2 | null = null;
  for (const c of candidates) {
    const lane = laneOf(c);
    if (lane) {
      anchor = c;
      outside = lane;
      break;
    }
  }

  const used = new Set<string>([cellKey(anchor.cell)]);
  const berths: Berth[] = [berthOf(req.ingress[0]!, anchor)];
  for (const service of req.ingress.slice(1)) {
    const next = nextBerth(candidates, anchor, used);
    if (!next) {
      break;
    }
    used.add(cellKey(next.cell));
    berths.push(berthOf(service, next));
  }

  return {
    cityId: req.cityId,
    quay: anchor.centre,
    bearing: berths[0]!.bearing,
    berths,
    outside,
  };
}

/** Moves a site from local to world coordinates. */
export function translateHarbour(site: HarbourSite, dx: number, dz: number): HarbourSite {
  const move = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dz];
  return {
    cityId: site.cityId,
    quay: move(site.quay),
    bearing: site.bearing,
    berths: site.berths.map((b) => ({
      ...b,
      position: move(b.position),
      dock: move(b.dock),
    })),
    outside: site.outside ? move(site.outside) : null,
  };
}

function berthOf(service: { nodeId: string; address: string }, c: Candidate): Berth {
  return {
    address: service.address,
    nodeId: service.nodeId,
    cell: c.cell,
    position: c.centre,
    // A building model faces −Z; this yaw turns that face toward the open sea.
    bearing: Math.atan2(-c.normal[0], -c.normal[1]),
    dock: mooring(c),
  };
}

function mooring(c: Candidate): Vec2 {
  const out = c.shore + BERTH_REACH;
  return [c.centre[0] + c.normal[0] * out, c.centre[1] + c.normal[1] * out];
}

/** The next berth along the same quay, or anywhere on the coast if the quay is full. */
function nextBerth(
  candidates: Candidate[],
  anchor: Candidate,
  used: Set<string>,
): Candidate | null {
  const free = candidates.filter((c) => !used.has(cellKey(c.cell)));
  const near = free
    .filter(
      (c) =>
        Math.hypot(c.centre[0] - anchor.centre[0], c.centre[1] - anchor.centre[1]) <= QUAY_SPREAD,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.centre[0] - anchor.centre[0], a.centre[1] - anchor.centre[1]) -
          Math.hypot(b.centre[0] - anchor.centre[0], b.centre[1] - anchor.centre[1]) ||
        a.cell[0] - b.cell[0] ||
        a.cell[1] - b.cell[1],
    );
  return near[0] ?? free[0] ?? null;
}

/**
 * Every free lattice cell on dry land, best coastal site first: outside the ring
 * road before inside it, then closest to the water.
 */
function coastalCells(req: HarbourRequest): Candidate[] {
  const bounds = polygonBounds(req.outline);
  if (!bounds) {
    return [];
  }
  const middle = polygonCentre(req.outline);
  const minI = Math.floor((bounds.cx - bounds.width / 2) / PITCH) - 1;
  const maxI = Math.ceil((bounds.cx + bounds.width / 2) / PITCH) + 1;
  const minJ = Math.floor((bounds.cz - bounds.height / 2) / PITCH) - 1;
  const maxJ = Math.ceil((bounds.cz + bounds.height / 2) / PITCH) + 1;

  const out: Candidate[] = [];
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const cell: [number, number] = [i, j];
      if (req.taken.has(cellKey(cell))) {
        continue;
      }
      const centre: Vec2 = [i * PITCH, j * PITCH];
      if (!pointInPolygon(centre, req.outline)) {
        continue;
      }
      const dx = centre[0] - middle[0];
      const dz = centre[1] - middle[1];
      const length = Math.hypot(dx, dz);
      out.push({
        cell,
        centre,
        normal: length > 0.01 ? [dx / length, dz / length] : [0, 1],
        shore: distToPolygon(centre, req.outline),
        inRing: req.ring.length >= 3 && pointInPolygon(centre, req.ring),
      });
    }
  }
  out.sort(
    (a, b) =>
      Number(a.inRing) - Number(b.inRing) ||
      a.shore - b.shore ||
      a.cell[0] - b.cell[0] ||
      a.cell[1] - b.cell[1],
  );
  return out;
}

/** Centre of the island as the shore sees it — the mean of the outline vertices. */
function polygonCentre(poly: Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / poly.length, z / poly.length];
}

/** How far offshore a sea lane is tested: past the furthest island, and then some. */
function seaReach(islands: Vec2[][]): number {
  let far = 40;
  for (const island of islands) {
    for (const p of island) {
      far = Math.max(far, Math.hypot(p[0], p[1]));
    }
  }
  return (far + 45) * 2;
}
