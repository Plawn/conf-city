import { expect, test } from "bun:test";
import { laneOffsets } from "@/components/geo/roadStyle";
import { trafficBudgets } from "@/components/traffic/budget";
import {
  QUAY_RUN,
  upgradeLayout,
  worldIdentity,
  worldRoutes,
} from "@/components/traffic/worldRoutes";
import sample from "@/data/sample.json";
import type { World } from "@/domain/types";
import { layoutWorld } from "@/layout/layoutWorld";
import { loadWorld } from "@/loaders/loadWorld";

const world = sample as World;
const { nodes, links } = loadWorld(world);
const base = layoutWorld(
  world.cities.map((c) => c.id),
  nodes,
  links,
);

test("road upgrades add lanes without moving plots; a grown bridge widens instead of stacking", () => {
  const first = base.cities.keys().next().value!;
  const bridge = base.bridges[0]!;
  const infra = { cities: { [first]: 1 as const }, bridges: { [bridge.key]: true } };
  const upgraded = upgradeLayout(base, infra);
  expect(upgraded.nodes).toBe(base.nodes);
  expect(upgraded.cities.get(first)!.outline).toBe(base.cities.get(first)!.outline);
  expect(upgraded.cities.get(first)!.roads.segments.every((s) => s.klass === "boulevard")).toBe(
    true,
  );
  const before = worldRoutes(base, links, { cities: {}, bridges: {} });
  const after = worldRoutes(upgraded, links, infra);
  expect(new Set(after.map((r) => r.key)).size).toBe(after.length);
  const crossings = before.filter((r) => r.bridgeKey === bridge.key);
  const expanded = after.filter((r) => r.bridgeKey === bridge.key);
  // One deck, one route per crossing, at the same height: the extra capacity is
  // lateral (a boulevard's outer lane), not a second level over the water.
  expect(expanded.length).toBe(crossings.length);
  expect(expanded.reduce((n, r) => n + r.rateScale, 0)).toBe(
    crossings.reduce((n, r) => n + r.rateScale, 0),
  );
  const top = (rs: typeof crossings) => Math.max(...rs.flatMap((r) => r.points.map((p) => p[1])));
  expect(top(expanded)).toBeCloseTo(top(crossings));
  const [, outer] = laneOffsets("boulevard");
  expect(expanded.some((r) => r.lanes?.some((l) => l[1] === outer))).toBe(true);
  expect(crossings.some((r) => r.lanes?.some((l) => l[1] === outer))).toBe(false);
  expect(trafficBudgets(expanded, 1000).total).toBeGreaterThan(
    trafficBudgets(crossings, 1000).total,
  );
});

test("local infrastructure identity ignores label and city order changes but separates node sets", () => {
  expect(
    worldIdentity({
      ...world,
      cities: [...world.cities].reverse().map((c) => ({ ...c, name: "renamed" })),
    }),
  ).toBe(worldIdentity(world));
  expect(
    worldIdentity({ ...world, cities: world.cities.map((c) => ({ ...c, nodes: [] })) }),
  ).not.toBe(worldIdentity(world));
});

test("the port's avenue is driven both ways, along the ring, at its own throughput", () => {
  const cityId = world.cities[0]!.id;
  // The traefik case: an ingress service nobody links to, which would otherwise
  // get the trickle of an isolated building on a two-cell stub.
  const portId = nodes.find((n) => n.cityId === cityId)!.id;
  const lonely = nodes.map((n) => (n.id === portId ? { ...n, links: [] } : n));
  const rest = links.filter((l) => l.fromNodeId !== portId && l.toNodeId !== portId);
  const layout = layoutWorld(
    world.cities.map((c) => c.id),
    lonely,
    rest,
    [],
    new Map(),
    new Set([`${cityId}/${portId}`]),
  );
  const routes = worldRoutes(layout, rest, { cities: {}, bridges: {} });
  const quay = routes.filter((r) => r.key?.startsWith(`${cityId}:port:${portId}:`));
  expect(quay.length).toBe(2);
  expect(routes.some((r) => r.key === `${cityId}:ring:${portId}`)).toBe(false);
  for (const route of quay) {
    // No fixed rate: `writeDemand` reads the service's own flow instead.
    expect(route.rate).toBeUndefined();
    expect(route.sourceAddr).toBe(`${cityId}/${portId}`);
    const length = route.points.reduce(
      (total, p, i) =>
        i === 0
          ? 0
          : total + Math.hypot(p[0] - route.points[i - 1]![0], p[2] - route.points[i - 1]![2]),
      0,
    );
    // The spur alone is barely two cells; the run along the ring is what makes
    // a lorry visible for more than a second.
    expect(length).toBeGreaterThan(QUAY_RUN);
  }
  // One road, driven in both directions: the ends swap.
  const [out, back] = quay as [(typeof quay)[0], (typeof quay)[0]];
  expect(back.points[back.points.length - 1]).toEqual(out.points[0]!);
});
