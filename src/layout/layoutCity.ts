import type { NodeType, PositionedNode, ResolvedLink, ResolvedNode } from "../domain/types";
import { GOLDEN_ANGLE } from "../lib/math";
import { fnv1a, mulberry32 } from "../lib/random";
import { FORCE_ITERATIONS, footprintRadius, LINK_REST, PITCH } from "./constants";
import { type Body, relax, type Spring } from "./force";
import { cellKey } from "./geometry";

/**
 * Lays out the nodes of ONE city around the local origin. World placement
 * (islands on the water) is done by `layoutWorld`.
 *
 * The shape is grown, not tabulated: intra-city links are springs, buildings
 * repel each other by footprint, and neighbourhoods pull their members together.
 * Cycles are a non-issue (no topological sort any more), and a city without a
 * single link simply keeps its phyllotaxis seed — a round blob.
 *
 * Discovered nodes are placed in a second pass with the static ones pinned, so
 * a node appearing at runtime never displaces the city that was already drawn.
 *
 * Everything ends up snapped to the lattice: one building per cell, position
 * exactly `(i·PITCH, j·PITCH)`, which `roads.ts` needs to reason about corners.
 *
 * `ports` are the ingress services: they are left out entirely, because the
 * shore and the ring road are offsets of the hull of what is laid out here — a
 * port inside that hull would push the coast in front of itself and never touch
 * the water. `layout/harbour.ts` puts them back on the shoreline afterwards.
 */

const TYPE_ORDER: Record<NodeType, number> = { app: 0, db: 1, cache: 2, queue: 3 };

/** Golden angle — the phyllotaxis seed spreads nodes evenly with no clumping. */

const DISCOVERED_GROUP = "__discovered";

export interface CityNodesLayout {
  /** Local coordinates, centred on the origin, snapped to the lattice. */
  nodes: PositionedNode[];
  /** Node id → lattice cell; `position = [i·PITCH, 0, j·PITCH]`. */
  cells: Map<string, [number, number]>;
}

/** Stable order: neighbourhood, then type, then id. Drives every seeded decision. */
function sortNodes<T extends ResolvedNode>(nodes: T[]): T[] {
  return [...nodes].sort(
    (a, b) =>
      (a.group ?? "").localeCompare(b.group ?? "") ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Collision radius: half a cell at least, so the relaxation already converges on
 * something the lattice snap can honour without shuffling the city around.
 * The real footprint (`footprintRadius`) still drives the island shore.
 */
function bodyRadius(type: NodeType): number {
  return Math.max(footprintRadius(type), PITCH * 0.5);
}

export function layoutCity(
  cityId: string,
  staticNodes: ResolvedNode[],
  discoveredNodes: ResolvedNode[],
  intraLinks: ResolvedLink[],
  ports: ReadonlySet<string> = new Set(),
): CityNodesLayout {
  const statics = sortNodes(staticNodes).filter((n) => !ports.has(n.id));
  const discovered = sortNodes(discoveredNodes).filter((n) => !ports.has(n.id));
  const all = [...statics, ...discovered];
  if (all.length === 0) {
    return { nodes: [], cells: new Map() };
  }

  const indexById = new Map<string, number>();
  all.forEach((n, i) => {
    indexById.set(n.id, i);
  });

  const rand = mulberry32(fnv1a(cityId));
  const bodies: Body[] = all.map((n, i) => {
    const radius = PITCH * 0.85 * Math.sqrt(i + 0.5);
    const angle = (i + 0.5) * GOLDEN_ANGLE;
    return {
      x: Math.cos(angle) * radius + (rand() - 0.5) * PITCH * 0.3,
      z: Math.sin(angle) * radius + (rand() - 0.5) * PITCH * 0.3,
      r: bodyRadius(n.type),
      group: n.group,
    };
  });

  const springs = buildSprings(intraLinks, indexById);
  const staticCount = statics.length;

  // Pass 1 — the static city, on its own.
  if (staticCount > 0) {
    const staticBodies = bodies.slice(0, staticCount);
    const staticSprings = springs.filter((s) => s.a < staticCount && s.b < staticCount);
    relax(staticBodies, staticSprings, {
      iterations: FORCE_ITERATIONS,
      groupK: 0.08,
      repelPadding: PITCH * 0.4,
      collisionMargin: 0.4,
    });
  }

  // Pass 2 — discovered nodes as a harbour district south of the static blob,
  // with the static buildings pinned as obstacles.
  if (discovered.length > 0) {
    let southZ = 0;
    let centerX = 0;
    for (let i = 0; i < staticCount; i++) {
      const b = bodies[i]!;
      southZ = Math.max(southZ, b.z);
      centerX += b.x;
    }
    if (staticCount > 0) {
      centerX /= staticCount;
    }
    for (let i = 0; i < discovered.length; i++) {
      const b = bodies[staticCount + i]!;
      const radius = PITCH * 0.85 * Math.sqrt(i + 0.5);
      const angle = (i + 0.5) * GOLDEN_ANGLE;
      b.x = centerX + Math.cos(angle) * radius + (rand() - 0.5) * PITCH * 0.3;
      b.z = southZ + PITCH * 2 + Math.abs(Math.sin(angle)) * radius;
      b.group = DISCOVERED_GROUP;
    }
    for (let i = 0; i < staticCount; i++) {
      bodies[i]!.fixed = true;
    }
    relax(bodies, springs, {
      iterations: FORCE_ITERATIONS,
      groupK: 0.06,
      repelPadding: PITCH * 0.4,
      collisionMargin: 0.4,
      centerK: 0,
      bias: [0, 1],
      biasK: 0.02,
    });
    for (let i = 0; i < staticCount; i++) {
      bodies[i]!.fixed = false;
    }
  }

  // Recentre on the static block only: local coordinates of the static city must
  // not shift the day a discovered node shows up south of it.
  const cells = snapToLattice(all, bodies, staticCount > 0 ? staticCount : all.length);
  const nodes: PositionedNode[] = all.map((n, i) => {
    const cell = cells.get(n.id)!;
    const positioned: PositionedNode = {
      ...n,
      position: [cell[0] * PITCH, 0, cell[1] * PITCH],
    };
    if (i >= staticCount) {
      positioned.isDiscovered = true;
    }
    return positioned;
  });
  return { nodes, cells };
}

/** One spring per unordered linked pair, deduplicated; unknown endpoints ignored. */
function buildSprings(intraLinks: ResolvedLink[], indexById: Map<string, number>): Spring[] {
  const seen = new Set<string>();
  const springs: Spring[] = [];
  const sorted = [...intraLinks].sort(
    (a, b) => a.fromNodeId.localeCompare(b.fromNodeId) || a.toNodeId.localeCompare(b.toNodeId),
  );
  for (const l of sorted) {
    const a = indexById.get(l.fromNodeId);
    const b = indexById.get(l.toNodeId);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    springs.push({ a, b, rest: LINK_REST });
  }
  return springs;
}

/**
 * Assigns each body the nearest free lattice cell (rings of growing Chebyshev
 * radius, ties broken by distance then index), then recentres by a whole number
 * of cells so the lattice — and therefore the road corners — stays exact.
 * Only the first `recenterCount` nodes weigh in on the recentring.
 */
function snapToLattice(
  nodes: ResolvedNode[],
  bodies: Body[],
  recenterCount: number,
): Map<string, [number, number]> {
  const taken = new Set<string>();
  const cells = new Map<string, [number, number]>();
  let minI = Infinity,
    maxI = -Infinity,
    minJ = Infinity,
    maxJ = -Infinity;

  for (let k = 0; k < nodes.length; k++) {
    const body = bodies[k]!;
    const idealI = body.x / PITCH;
    const idealJ = body.z / PITCH;
    const baseI = Math.round(idealI);
    const baseJ = Math.round(idealJ);
    let chosen: [number, number] | null = null;
    for (let ring = 0; ring < 64 && !chosen; ring++) {
      const candidates: [number, number][] = [];
      for (let di = -ring; di <= ring; di++) {
        for (let dj = -ring; dj <= ring; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) {
            continue;
          }
          const cell: [number, number] = [baseI + di, baseJ + dj];
          if (!taken.has(cellKey(cell))) {
            candidates.push(cell);
          }
        }
      }
      candidates.sort((a, b) => {
        const da = (a[0] - idealI) ** 2 + (a[1] - idealJ) ** 2;
        const db = (b[0] - idealI) ** 2 + (b[1] - idealJ) ** 2;
        return da - db || a[0] - b[0] || a[1] - b[1];
      });
      chosen = candidates[0] ?? null;
    }
    const cell = chosen ?? [baseI, baseJ];
    taken.add(cellKey(cell));
    cells.set(nodes[k]!.id, cell);
    if (k < recenterCount) {
      minI = Math.min(minI, cell[0]);
      maxI = Math.max(maxI, cell[0]);
      minJ = Math.min(minJ, cell[1]);
      maxJ = Math.max(maxJ, cell[1]);
    }
  }

  const shiftI = -Math.round((minI + maxI) / 2);
  const shiftJ = -Math.round((minJ + maxJ) / 2);
  for (const cell of cells.values()) {
    cell[0] += shiftI;
    cell[1] += shiftJ;
  }
  return cells;
}
