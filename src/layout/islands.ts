import type { ResolvedLink } from "../domain/types";
import { GOLDEN_ANGLE } from "../lib/math";
import { pairKey } from "./bridges";
import { FORCE_ITERATIONS, WATER_GAP } from "./constants";
import { type Body, relax, type Spring } from "./force";
import { centroid } from "./geometry";
import type { LocalCity } from "./localCity";
import { type Bridgehead, type GateRequest, planBridgehead } from "./roads/bridgehead";
import { translate } from "./translate";
import { linkKey, type Vec2 } from "./types";

/**
 * Relaxes the islands as discs: springs for linked pairs, hard `WATER_GAP`
 * separation, then integer offsets recentred on the origin.
 */
export function placeIslands(locals: LocalCity[], links: ResolvedLink[]): Vec2[] {
  if (locals.length === 0) {
    return [];
  }
  const indexOf = new Map(locals.map((l, i) => [l.cityId, i]));
  const avgRadius = locals.reduce((s, l) => s + l.radius, 0) / locals.length;
  const spacing = avgRadius * 2 + WATER_GAP;
  const bodies: Body[] = locals.map((l, i) => {
    const r = spacing * Math.sqrt(i + 0.5);
    // Golden angle — same phyllotaxis seed as inside a city, one scale up.
    const a = (i + 0.5) * GOLDEN_ANGLE;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, r: l.radius };
  });

  const weights = new Map<string, number>();
  for (const l of links) {
    if (!l.interCity) {
      continue;
    }
    const a = indexOf.get(l.fromCityId);
    const b = indexOf.get(l.toCityId);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const springs: Spring[] = [...weights.keys()].sort().map((key) => {
    const [a, b] = key.split(":").map(Number) as [number, number];
    return {
      a,
      b,
      rest: locals[a]!.radius + locals[b]!.radius + WATER_GAP,
      k: Math.min(weights.get(key) ?? 1, 3),
    };
  });

  relax(bodies, springs, {
    iterations: FORCE_ITERATIONS,
    springK: 0.25,
    repelK: 0.4,
    repelPadding: WATER_GAP,
    centerK: 0.01,
    collisionMargin: WATER_GAP,
  });

  const offsets: Vec2[] = bodies.map((b) => [Math.round(b.x), Math.round(b.z)]);
  const mid = centroid(offsets);
  const cx = Math.round(mid[0]);
  const cz = Math.round(mid[1]);
  return offsets.map(([x, z]) => [x - cx, z - cz] as Vec2);
}

/**
 * Plans one bridgehead per (linked city pair, city) on the city's ring road,
 * facing the other island, and attaches it to the ring. Returns the gates in
 * world coordinates per pair (ordered like the pair key) and, per city, the
 * feeder routes `buildRoadNetwork` must add.
 *
 * The bridgehead is one `Vec2` shared by the ring, the roundabout, the feeder
 * route and — translated by the island's integer offset, the same arithmetic
 * `translateRoads` applies — the bridge: what keeps them matching by value.
 */
export function planGates(
  locals: LocalCity[],
  offsets: Vec2[],
  links: ResolvedLink[],
): { pairGates: Map<string, [Vec2, Vec2]>; gateRequests: Map<string, GateRequest[]> } {
  const localOf = new Map<string, { local: LocalCity; offset: Vec2 }>();
  locals.forEach((local, i) => {
    localOf.set(local.cityId, { local, offset: offsets[i]! });
  });

  const interLinks = new Map<string, ResolvedLink>();
  for (const l of links) {
    if (!l.interCity || !localOf.has(l.fromCityId) || !localOf.has(l.toCityId)) {
      continue;
    }
    const key = linkKey(l);
    if (!interLinks.has(key)) {
      interLinks.set(key, l);
    }
  }

  // Bridgehead per pair, per city (keyed "pair→cityId").
  const heads = new Map<string, Bridgehead>();
  const pairGates = new Map<string, [Vec2, Vec2]>();
  const pinned = new Map<string, Set<Vec2>>();
  const pairs = [...new Set([...interLinks.values()].map(pairKey))].sort();
  for (const pair of pairs) {
    const [idA, idB] = pair.split("|") as [string, string];
    const a = localOf.get(idA)!;
    const b = localOf.get(idB)!;
    const gateOf = (
      here: { local: LocalCity; offset: Vec2 },
      there: { local: LocalCity; offset: Vec2 },
    ): Bridgehead | null => {
      const centerHere = translate(centroid(here.local.ring), here.offset[0], here.offset[1]);
      const centerThere = translate(centroid(there.local.ring), there.offset[0], there.offset[1]);
      const toward: Vec2 = [centerThere[0] - centerHere[0], centerThere[1] - centerHere[1]];
      let held = pinned.get(here.local.cityId);
      if (!held) {
        held = new Set();
        pinned.set(here.local.cityId, held);
      }
      return planBridgehead(here.local.layout, here.local.grid, here.local.ring, toward, held);
    };
    const gateA = gateOf(a, b);
    const gateB = gateOf(b, a);
    if (!gateA || !gateB) {
      continue;
    }
    heads.set(`${pair}→${idA}`, gateA);
    heads.set(`${pair}→${idB}`, gateB);
    pairGates.set(pair, [
      translate(gateA.hit, a.offset[0], a.offset[1]),
      translate(gateB.hit, b.offset[0], b.offset[1]),
    ]);
  }

  const gateRequests = new Map<string, GateRequest[]>();
  const requestFor = (cityId: string, key: string, nodeId: string, gate: Bridgehead) => {
    const list = gateRequests.get(cityId);
    const req = { key, nodeId, gate };
    if (list) {
      list.push(req);
    } else {
      gateRequests.set(cityId, [req]);
    }
  };
  for (const key of [...interLinks.keys()].sort()) {
    const link = interLinks.get(key)!;
    const pair = pairKey(link);
    const gateFrom = heads.get(`${pair}→${link.fromCityId}`);
    const gateTo = heads.get(`${pair}→${link.toCityId}`);
    if (!gateFrom || !gateTo) {
      continue;
    }
    requestFor(link.fromCityId, key, link.fromNodeId, gateFrom);
    requestFor(link.toCityId, key, link.toNodeId, gateTo);
  }

  return { pairGates, gateRequests };
}
