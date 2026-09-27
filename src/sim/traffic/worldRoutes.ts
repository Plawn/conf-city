import type { Infrastructure } from "../../domain/mobility";
import type { ResolvedLink, World } from "../../domain/types";
import { deckClass, makeDriver } from "../../geo/drivable";
import { linkKey, type Vec2, type WorldLayout } from "../../layout/types";
import { fnv1a } from "../../lib/random";
import type { TrafficRoute } from "./pool";

export function worldIdentity(world: World): string {
  return fnv1a(
    JSON.stringify(
      world.cities
        .map(
          (c) =>
            `${c.id}:${c.nodes
              .map((n) => n.id)
              .sort()
              .join(",")}`,
        )
        .sort(),
    ),
  ).toString(16);
}

/** Existing plots stay put: widening uses the space reserved around the road grid. */
export function upgradeLayout(layout: WorldLayout, infra: Infrastructure): WorldLayout {
  return {
    ...layout,
    cities: new Map(
      [...layout.cities].map(([id, city]) => [
        id,
        infra.cities[id]
          ? {
              ...city,
              roads: {
                ...city.roads,
                segments: city.roads.segments.map((s) => ({ ...s, klass: "boulevard" as const })),
                roundabouts: city.roads.roundabouts.map((s) => ({
                  ...s,
                  klass: "boulevard" as const,
                })),
                // Driveways retain their width at the building entrance.
              },
            }
          : city,
      ]),
    ),
  };
}

export function worldRoutes(
  layout: WorldLayout,
  links: ResolvedLink[],
  infra: Infrastructure,
): TrafficRoute[] {
  const out: TrafficRoute[] = [];
  for (const [cityId, city] of layout.cities) {
    const driver = makeDriver([city.roads]);
    const occurrences = new Map<string, number>();
    for (const link of links.filter((l) => !l.interCity && l.fromCityId === cityId)) {
      const key = linkKey(link);
      const road = city.roads.routes.get(key);
      if (!road) {
        continue;
      }
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      out.push({
        ...driver.street(road.points),
        key: `${key}:${occurrence}`,
        zone: `city:${cityId}`,
        cityId,
        sourceAddr: `${cityId}/${link.fromNodeId}`,
        rateScale: link.inferred ? 0.5 : 1,
      });
    }
    for (const reverse of [false, true]) {
      const path = driver.loop(city.roads.ring, reverse);
      if (path) {
        out.push({
          ...path,
          key: `${cityId}:loop:${reverse}`,
          zone: `city:${cityId}`,
          cityId,
          ambientCityId: cityId,
          loop: true,
          rateScale: 1,
        });
      }
    }
    for (const node of city.nodes) {
      const path = city.roads.routes.get(`ring:${node.id}`);
      if (!path) {
        continue;
      }
      if (node.isPort) {
        // The port is where the outside world comes ashore: its avenue carries
        // the freight of the whole island, in both directions, at the rate the
        // service's own throughput sets — not the trickle of a building nobody
        // links to. On its own the spur is barely two cells long, so a lorry
        // would appear and vanish within a second; the run along the ring gives
        // it somewhere to come from and somewhere to go.
        const quayside = alongRing(path.points, city.roads.ring);
        for (const [way, points] of [
          ["out", quayside],
          ["in", [...quayside].reverse()],
        ] as const) {
          out.push({
            ...driver.street(points),
            key: `${cityId}:port:${node.id}:${way}`,
            zone: `city:${cityId}`,
            cityId,
            sourceAddr: `${cityId}/${node.id}`,
            rateScale: 1,
          });
        }
        continue;
      }
      out.push({
        ...driver.street(path.points),
        key: `${cityId}:ring:${node.id}`,
        zone: `city:${cityId}`,
        cityId,
        sourceAddr: `${cityId}/${node.id}`,
        rateScale: 1,
        rate: 0.03,
      });
    }
  }
  const driver = makeDriver([...layout.cities.values()].map((c) => c.roads));
  for (const bridge of layout.bridges) {
    // An upgraded bridge is *one* wider deck, not two stacked ones: the same
    // crossing is driven on a boulevard, whose second lane each way is the
    // capacity the upgrade buys (`trafficBudgets` counts lanes, not routes).
    const klass = deckClass(infra.bridges[bridge.key]);
    for (const [i, crossing] of bridge.crossings.entries()) {
      out.push({
        ...driver.crossing(crossing.points, crossing.waterSpan, klass),
        key: `bridge:${bridge.key}:${crossing.key}:${i}`,
        zone: `bridge:${bridge.key}`,
        bridgeKey: bridge.key,
        cityId: crossing.link.fromCityId,
        targetCityId: crossing.link.toCityId,
        sourceAddr: `${crossing.link.fromCityId}/${crossing.link.fromNodeId}`,
        rateScale: crossing.link.inferred ? 0.5 : 1,
      });
    }
  }
  return out;
}

/** How far a lorry runs along the ring road before it is done with the quay. */
export const QUAY_RUN = 26;

/**
 * The quay's spur, continued along the ring road for `QUAY_RUN`.
 *
 * The spur ends on a ring vertex (`roads/` attaches it there, by identity),
 * so the walk is a plain slice of the ring polygon — no new arithmetic, no
 * point that the roundabouts, the drawn segments and the lane lookup would fail
 * to recognise. The ring is walked in its own winding order, so the two ways of
 * the quay are each other's reverse and the pair reads as one road.
 */
function alongRing(spur: Vec2[], ring: Vec2[]): Vec2[] {
  const mouth = spur[spur.length - 1];
  if (!mouth || ring.length < 3) {
    return spur;
  }
  const at = ring.findIndex((p) => p[0] === mouth[0] && p[1] === mouth[1]);
  if (at < 0) {
    return spur;
  }
  const points = [...spur];
  let run = 0;
  let previous = mouth;
  for (let k = 1; k <= ring.length && run < QUAY_RUN; k++) {
    const next = ring[(at + k) % ring.length]!;
    run += Math.hypot(next[0] - previous[0], next[1] - previous[1]);
    points.push(next);
    previous = next;
  }
  return points;
}
