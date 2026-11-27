import type { PlotSettle, PositionedNode } from "../domain/types";
import { CLASS_STYLE, PAVEMENT, ringRadii } from "../geo/roadStyle";
import { fnv1a, mulberry32 } from "../lib/random";
import { footprintRadius, PITCH } from "./constants";
import { distToPolygon, distToPolyline, distToSegment, pointInPolygon, vecKey } from "./geometry";
import type { Driveway, RoadNetwork, Vec2 } from "./types";
import { type CityWarp, IDENTITY_WARP } from "./warp";

/**
 * Organic placement inside the lattice. Each building faces its street, square to
 * the (gently bent) lattice, and sits off-centre in its plot; its driveway door
 * follows. Three things break the one-building-per-cell look:
 * - **lots**: the weightiest services (streets, stores) spread onto free cells beside them (2×1, 2×2);
 * - **shared blocks**: same-neighbourhood buildings with no street between them
 *   close ranks until they nearly touch;
 * - **districts**: a neighbourhood of `DISTRICT_MIN`+ rises into a skyline.
 * The lattice, mouths and route points never move — only buildings and their
 * doors — so the exact-equality road invariant holds. Pure and seeded by address.
 */

/** Largest shift off the plot centre, before the kerb check shrinks it. */
const MAX_SHIFT = 0.8;
/** Largest shift towards a block-mate: enough to close a plot down to a seam. */
const BLOCK_SHIFT = 1.6;
/** Seam left between two buildings of one block. */
const BLOCK_SEAM = 0.25;
/** Never closer than this to another building's footprint. */
const BUILDING_GAP = 0.15;
/** Kept between a footprint and the pavement edge. */
const KERB_MARGIN = 0.15;
/**
 * A neighbourhood of at least this many buildings reads as a district: its
 * buildings huddle towards its centre and rise into a skyline.
 */
export const DISTRICT_MIN = 3;
/** Extra height of a district's core tower, as a fraction of the model's own. */
const RISE_MAX = 0.6;
/** Members at which a district reaches its full skyline. */
const RISE_FULL = 5;
/** Share of a city's services (the weightiest) that get a lot of their own. */
const LOT_SHARE = 0.25;
/** Weight a service needs for a 2×1 lot, and for a 2×2 one: its streets, plus its type's heft. */
const LOT_WIDE = 2;
const LOT_SQUARE = 4;
/** Stores are the big sheds of a city. */
const HEFT: Record<PositionedNode["type"], number> = { app: 0, cache: 0.5, queue: 1, db: 1.5 };
/** Model stretch along a lot's long side (2×1), and both ways on a 2×2. */
const STRETCH_WIDE = 1.75;
const STRETCH_SQUARE = 1.6;
/** Lots keep this far from the ring: the shore band stays open. */
const RING_CLEAR = 1;
/** Where a lot's footprint is probed, in half-extents. */
const SAMPLES = [-1, -0.5, 0, 0.5, 1];

/** Shrink steps tried, largest first, until the footprint clears every kerb. */
const STEPS = [1, 0.75, 0.5, 0.25, 0];

type Cell = [number, number];

/** Clearance from `p` to a street's pavement edge or a roundabout's outer kerb. */
type Obstacle = (p: Vec2) => number;

function obstacles(roads: RoadNetwork): Obstacle[] {
  const out: Obstacle[] = [];
  for (const s of roads.segments) {
    const edge = CLASS_STYLE[s.klass].width / 2 + PAVEMENT;
    out.push((p) => distToPolyline(p, s.points) - edge);
  }
  for (const r of roads.roundabouts) {
    const edge = ringRadii(r).outer + PAVEMENT;
    out.push((p) => Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) - edge);
  }
  return out;
}

/** The driveway a building faces: its nearest mouth, then the lowest key for a stable pick. */
function frontage(centre: Vec2, own: Driveway[]): Driveway | undefined {
  let best: { d: Driveway; len: number; key: string } | undefined;
  for (const d of own) {
    const len = Math.hypot(d.mouth[0] - centre[0], d.mouth[1] - centre[1]);
    const key = vecKey(d.mouth);
    if (!best || len < best.len - 1e-9 || (Math.abs(len - best.len) <= 1e-9 && key < best.key)) {
      best = { d, len, key };
    }
  }
  return best?.d;
}

interface District {
  center: Vec2;
  /** Farthest member from the centre. */
  reach: number;
  /** 0 → 1 as the district grows to `RISE_FULL` members. */
  size: number;
}

/** Neighbourhoods big enough to read as districts, by group name. */
function planDistricts(nodes: PositionedNode[]): Map<string, District> {
  const members = new Map<string, Vec2[]>();
  for (const n of nodes) {
    if (n.isPort || !n.group) {
      continue;
    }
    const list = members.get(n.group) ?? [];
    list.push([n.position[0], n.position[2]]);
    members.set(n.group, list);
  }
  const out = new Map<string, District>();
  for (const [group, cells] of members) {
    if (cells.length < DISTRICT_MIN) {
      continue;
    }
    const center: Vec2 = [
      cells.reduce((a, c) => a + c[0], 0) / cells.length,
      cells.reduce((a, c) => a + c[1], 0) / cells.length,
    ];
    const reach = Math.max(...cells.map((c) => Math.hypot(c[0] - center[0], c[1] - center[1])));
    const size = Math.min(1, (cells.length - DISTRICT_MIN + 1) / (RISE_FULL - DISTRICT_MIN + 1));
    out.set(group, { center, reach, size });
  }
  return out;
}

/** Streets each building opens onto: its links and its ring driveway, by node id. */
function degrees(cityId: string, roads: RoadNetwork): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1);
  const prefix = `${cityId}/`;
  for (const key of roads.routes.keys()) {
    if (key.startsWith("ring:")) {
      bump(key.slice(5));
      continue;
    }
    for (const end of key.split("->")) {
      if (end.startsWith(prefix)) {
        bump(end.slice(prefix.length));
      }
    }
  }
  return out;
}

/** A footprint as circles: one per lot cell (a plain plot is a single circle). */
export interface Footprint {
  at: Vec2;
  r: number;
}

/**
 * The circles a settled building covers, in the same coordinates as `node.position`.
 * Props and the utility plot keep off them.
 */
export function plotFootprint(node: PositionedNode, r: number): Footprint[] {
  const x = node.position[0];
  const z = node.position[2];
  const plot = node.plot;
  if (!plot) {
    return [{ at: [x, z], r }];
  }
  if (!plot.lot) {
    return [{ at: [x + plot.offset[0], z + plot.offset[1]], r }];
  }
  return plot.lot.cells.map((c) => ({ at: [x + c[0], z + c[1]], r }));
}

interface Lot {
  /** Lot cells' warped centres, relative to the building's own. */
  cells: Vec2[];
  /** Stretch along the lattice's x and z. */
  stretch: [number, number];
}

/**
 * Settles every building of one city (local coordinates, before the island's
 * translation). Returns the nodes with their `plot`, and the roads with each
 * door moved by its building. Ports keep the bearing the shore gave them.
 * `cells` maps every building of the city — drawn or still to come — to its lattice
 * cell, and `warp` is the bend the lattice went through; without them the
 * positions are taken as the unbent lattice.
 */
export function settlePlots(
  cityId: string,
  nodes: PositionedNode[],
  roads: RoadNetwork,
  warp: CityWarp = IDENTITY_WARP,
  cells?: ReadonlyMap<string, Cell>,
): { nodes: PositionedNode[]; roads: RoadNetwork } {
  if (roads.segments.length === 0 && roads.driveways.length === 0) {
    return { nodes, roads };
  }
  const all = obstacles(roads);
  const districts = planDistricts(nodes);
  const doors = roads.driveways.map((d) => d.door);
  const cellOf = (n: PositionedNode): Cell =>
    cells?.get(n.id) ?? [Math.round(n.position[0] / PITCH), Math.round(n.position[2] / PITCH)];
  const at = (c: Vec2): Vec2 => warp.apply([c[0] * PITCH, c[1] * PITCH]);
  const taken = new Map<string, PositionedNode>();
  for (const n of nodes) {
    taken.set(`${cellOf(n)}`, n);
  }
  // Cells of buildings not drawn yet (a city still growing) are never built over.
  const reserved = new Set([...(cells?.values() ?? [])].map((c) => `${c}`));
  const ownership = new Map(
    nodes.map((n) => {
      const centre: Vec2 = [n.position[0], n.position[2]];
      return [
        n.id,
        roads.driveways
          .map((d, i) => ({ d, i }))
          .filter(({ d }) => Math.hypot(d.door[0] - centre[0], d.door[1] - centre[1]) < PITCH / 2),
      ];
    }),
  );
  /** Someone else's driveway: a lot never builds over it. */
  const drives = nodes.flatMap((n) =>
    ownership.get(n.id)!.map(({ d }) => ({
      owner: n.id,
      clear: (p: Vec2) =>
        distToSegment(p, d.mouth, d.door) - CLASS_STYLE[d.klass].width / 2 - PAVEMENT,
    })),
  );
  /** Nothing drawn crosses `p` within `need`. */
  const open = (p: Vec2, need: number, self: string, kerb = need) =>
    all.every((o) => o(p) >= kerb - 1e-9) &&
    drives.every((d) => d.owner === self || d.clear(p) >= need);
  const kerbAt = (p: Vec2) => Math.min(PITCH, ...all.map((o) => o(p)));
  const ring = roads.ring;
  const inland = (p: Vec2) =>
    ring.length < 3 || (pointInPolygon(p, ring) && distToPolygon(p, ring) >= RING_CLEAR);
  /** No street on the lattice edge between two neighbouring cells. */
  const seamless = (a: Cell, b: Cell) => {
    const mid = at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    return all.every((o) => o(mid) > 0.3);
  };

  /** The way each building faces, in the lattice's own (unbent) frame. */
  const facing = new Map<string, Cell>();
  for (const n of nodes) {
    if (n.isPort) {
      continue;
    }
    const centre: Vec2 = [n.position[0], n.position[2]];
    const front = frontage(
      centre,
      ownership.get(n.id)!.map(({ d }) => d),
    );
    if (front) {
      const theta = warp.angleAt(centre);
      const rx = front.mouth[0] - centre[0];
      const rz = front.mouth[1] - centre[1];
      // Square to the (bent) streets, whatever angle a ring driveway leaves at.
      const dx = rx * Math.cos(theta) + rz * Math.sin(theta);
      const dz = -rx * Math.sin(theta) + rz * Math.cos(theta);
      facing.set(
        n.id,
        Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1],
      );
    }
  }

  // Lots first, best-connected services first: each claims free cells beside it,
  // along its frontage before behind it, never across its own street.
  const degree = degrees(cityId, roads);
  const weight = (n: PositionedNode) => (degree.get(n.id) ?? 0) + HEFT[n.type];
  const lots = new Map<string, Lot>();
  const buildings = nodes.filter((n) => !n.isPort);
  const bigFirst = buildings
    .filter((n) => weight(n) >= LOT_WIDE)
    .sort((a, b) => weight(b) - weight(a) || (a.id < b.id ? -1 : 1))
    .slice(0, Math.ceil(buildings.length * LOT_SHARE));
  for (const n of bigFirst) {
    const home = cellOf(n);
    const centre: Vec2 = [n.position[0], n.position[2]];
    const rel = (c: Vec2): Vec2 => {
      const p = at(c);
      return [p[0] - centre[0], p[1] - centre[1]];
    };
    const r = footprintRadius(n.type);
    // The stretched footprint, sampled in the lattice frame: no closer to a kerb than
    // the home plot already stands, never over someone else's driveway.
    const floor = Math.min(KERB_MARGIN, kerbAt(centre) - r);
    const fits = (cs: Cell[], stretch: [number, number]) => {
      const cx = cs.reduce((a, c) => a + c[0], 0) / cs.length;
      const cz = cs.reduce((a, c) => a + c[1], 0) / cs.length;
      const hx = (r * stretch[0]) / PITCH;
      const hz = (r * stretch[1]) / PITCH;
      for (const u of SAMPLES) {
        for (const v of SAMPLES) {
          const p = at([cx + u * hx, cz + v * hz]);
          if (kerbAt(p) < floor - 1e-9 || !open(p, 0, n.id, -PITCH)) {
            return false;
          }
        }
      }
      return true;
    };
    const free = (c: Cell) => !taken.has(`${c}`) && !reserved.has(`${c}`) && inland(at(c));
    const beside = (d: Cell): Cell | null => {
      const c: Cell = [home[0] + d[0], home[1] + d[1]];
      return free(c) && seamless(home, c) ? c : null;
    };
    const f = facing.get(n.id) ?? [0, 1];
    const side: Cell = [f[1], f[0]];
    let lot: Lot | null = null;
    let claimed: Cell[] = [];
    if (weight(n) >= LOT_SQUARE) {
      for (const [s, b] of [
        [1, -1],
        [-1, -1],
      ] as const) {
        const a = beside([side[0] * s, side[1] * s]);
        const back = beside([f[0] * b, f[1] * b]);
        if (!a || !back) {
          continue;
        }
        const c: Cell = [a[0] + back[0] - home[0], a[1] + back[1] - home[1]];
        if (
          free(c) &&
          seamless(a, c) &&
          seamless(back, c) &&
          fits([home, a, back, c], [STRETCH_SQUARE, STRETCH_SQUARE])
        ) {
          claimed = [a, back, c];
          lot = {
            cells: [home, ...claimed].map(rel),
            stretch: [STRETCH_SQUARE, STRETCH_SQUARE],
          };
          break;
        }
      }
    }
    if (!lot) {
      for (const d of [side, [-side[0], -side[1]] as Cell, [-f[0], -f[1]] as Cell]) {
        const c = beside(d);
        const stretch: [number, number] = d[0] !== 0 ? [STRETCH_WIDE, 1] : [1, STRETCH_WIDE];
        if (c && fits([home, c], stretch)) {
          claimed = [c];
          lot = { cells: [[0, 0], rel(c)], stretch };
          break;
        }
      }
    }
    if (lot) {
      for (const c of claimed) {
        taken.set(`${c}`, n);
      }
      lots.set(n.id, lot);
    }
  }

  /** Same-neighbourhood buildings on the next cells with no street in between, by direction. */
  const mates = (n: PositionedNode): { d: Cell; other: PositionedNode }[] => {
    if (!n.group) {
      return [];
    }
    const home = cellOf(n);
    const out: { d: Cell; other: PositionedNode }[] = [];
    for (const d of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as Cell[]) {
      const c: Cell = [home[0] + d[0], home[1] + d[1]];
      const other = taken.get(`${c}`);
      if (
        other &&
        other !== n &&
        other.group === n.group &&
        !lots.has(other.id) &&
        seamless(home, c)
      ) {
        out.push({ d, other });
      }
    }
    return out;
  };

  // Lots are placed first: every other building keeps off them.
  const placed: Footprint[] = [];
  for (const n of nodes) {
    for (const c of lots.get(n.id)?.cells ?? []) {
      placed.push({ at: [n.position[0] + c[0], n.position[2] + c[1]], r: footprintRadius(n.type) });
    }
  }

  const settled = nodes.map((n) => {
    if (n.isPort) {
      return n;
    }
    const centre: Vec2 = [n.position[0], n.position[2]];
    const own = ownership.get(n.id)!;
    const rand = mulberry32(fnv1a(`plot:${cityId}/${n.id}`));
    const theta = warp.angleAt(centre);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    /** Lattice frame → world. */
    const turn = (v: Vec2): Vec2 => [v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos];
    let local = facing.get(n.id);
    if (!local) {
      const a = Math.floor(rand() * 4) * (Math.PI / 2);
      local = [Math.round(Math.sin(a)), Math.round(Math.cos(a))];
    }
    const dir = turn(local);
    // Models face −Z: this yaw turns their front door towards `dir`.
    const yaw = Math.atan2(-dir[0], -dir[1]);
    const district = n.group ? districts.get(n.group) : undefined;
    let rise: number | undefined;
    if (district) {
      const len = Math.hypot(district.center[0] - centre[0], district.center[1] - centre[1]);
      const core = district.reach > 1e-9 ? 1 - len / district.reach : 1;
      // The whole district stands above the outskirts; its core highest.
      rise = 1 + RISE_MAX * district.size * (0.3 + 0.7 * core);
    }
    const tag = district ? { district: n.group!, rise: rise! } : {};
    const r = footprintRadius(n.type);
    const lot = lots.get(n.id);

    if (lot) {
      // The building stands on the middle of its lot, stretched to fill it.
      const k = lot.cells.length;
      const offset: Vec2 = [
        lot.cells.reduce((a, c) => a + c[0], 0) / k,
        lot.cells.reduce((a, c) => a + c[1], 0) / k,
      ];
      // In the model's frame: x along its front, z its depth.
      const stretch: [number, number] =
        local[0] === 0 ? [lot.stretch[0], lot.stretch[1]] : [lot.stretch[1], lot.stretch[0]];
      // The door stays on the building's face: a deeper lot pushes it forward again.
      const ahead = r * (stretch[1] - 1);
      for (const { i } of own) {
        doors[i] = [
          doors[i]![0] + offset[0] + dir[0] * ahead,
          doors[i]![1] + offset[1] + dir[1] * ahead,
        ];
      }
      return { ...n, plot: { offset, yaw, lot: { cells: lot.cells, stretch }, ...tag } };
    }

    const block = mates(n);
    let want: Vec2;
    if (block.length > 0) {
      // One block: close ranks with the neighbours across each street-less seam.
      const pull: Vec2 = [0, 0];
      for (const { d, other } of block) {
        const gap = PITCH - r - footprintRadius(other.type) - BLOCK_SEAM;
        const s = Math.min(BLOCK_SHIFT, Math.max(0, gap / 2));
        pull[0] += d[0] * s;
        pull[1] += d[1] * s;
      }
      want = turn(pull);
    } else if (district) {
      // Huddled towards the district's core.
      const dx = district.center[0] - centre[0];
      const dz = district.center[1] - centre[1];
      const len = Math.hypot(dx, dz);
      const k = len > 1e-9 ? (MAX_SHIFT * (0.8 + 0.2 * rand())) / len : 0;
      want = [dx * k, dz * k];
    } else {
      // Mostly up to the street, sometimes set back; a little slide along the frontage.
      const along = (rand() * 1.3 - 0.3) * MAX_SHIFT;
      const across = (rand() * 2 - 1) * 0.4 * MAX_SHIFT;
      want = [dir[0] * along - dir[1] * across, dir[1] * along + dir[0] * across];
    }

    // Never closer to a kerb than the footprint allows (or than the centre already
    // was), and never into another building.
    const need = r + KERB_MARGIN;
    const near = all
      .map((o) => ({ o, floor: Math.min(need, o(centre)) }))
      .filter(({ floor }) => floor < PITCH);
    let offset: Vec2 = [0, 0];
    for (const s of STEPS) {
      const o: Vec2 = [want[0] * s, want[1] * s];
      const p: Vec2 = [centre[0] + o[0], centre[1] + o[1]];
      const kerbs = near.every(({ o: ob, floor }) => ob(p) >= floor - 1e-9);
      const clear =
        s === 0 ||
        placed.every(
          (f) => Math.hypot(f.at[0] - p[0], f.at[1] - p[1]) >= f.r + r + BUILDING_GAP - 1e-9,
        );
      if (kerbs && clear) {
        offset = o;
        break;
      }
    }
    placed.push({ at: [centre[0] + offset[0], centre[1] + offset[1]], r });
    for (const { i } of own) {
      doors[i] = [doors[i]![0] + offset[0], doors[i]![1] + offset[1]];
    }
    const plot: PlotSettle = { offset, yaw, ...tag };
    return { ...n, plot };
  });
  return {
    nodes: settled,
    roads: { ...roads, driveways: roads.driveways.map((d, i) => ({ ...d, door: doors[i]! })) },
  };
}

/**
 * The offset actually drawn once the building is `radius` wide: a footprint grown
 * past the one the plot was settled for gives the excess back towards the centre.
 * A lot keeps its offset — it is the middle of the lot, not a nudge.
 */
export function drawnOffset(plot: PlotSettle, settledRadius: number, radius: number): Vec2 {
  const len = Math.hypot(plot.offset[0], plot.offset[1]);
  if (len === 0 || plot.lot) {
    return plot.offset;
  }
  const k = Math.max(0, len - Math.max(0, radius - settledRadius)) / len;
  return [plot.offset[0] * k, plot.offset[1] * k];
}
