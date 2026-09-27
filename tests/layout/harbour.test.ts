import { expect, test } from "bun:test";
import sample from "@/data/sample.json";
import type { World } from "@/domain/types";
import { PITCH } from "@/layout/constants";
import { distToPolygon, pointInPolygon, vecKey } from "@/layout/geometry";
import { layoutWorld } from "@/layout/layoutWorld";
import type { Vec2 } from "@/layout/types";
import { loadWorld } from "@/loaders/loadWorld";

const cityIds = sample.cities.map((c) => c.id);

/** The sample world, with the given addresses turned into ingress services. */
function world(ingress: string[] = []) {
  const { nodes, links } = loadWorld(sample as World);
  return layoutWorld(cityIds, nodes, links, [], new Map(), new Set(ingress));
}

/** First static node of a city, as an address. */
function firstOf(cityId: string): string {
  const { nodes } = loadWorld(sample as World);
  return `${cityId}/${nodes.find((n) => n.cityId === cityId)!.id}`;
}

test("no ingress leaves the layout byte-for-byte as it was", () => {
  const a = world();
  const b = world();
  expect([...a.cities.keys()]).toEqual([...b.cities.keys()]);
  for (const [id, city] of a.cities) {
    const other = b.cities.get(id)!;
    expect(other.harbour).toBeUndefined();
    expect(city.harbour).toBeUndefined();
    expect(other.outline.map(vecKey)).toEqual(city.outline.map(vecKey));
    expect(other.roads.ring.map(vecKey)).toEqual(city.roads.ring.map(vecKey));
    expect(other.nodes.map((n) => `${n.id}@${n.position.join(",")}`)).toEqual(
      city.nodes.map((n) => `${n.id}@${n.position.join(",")}`),
    );
  }
});

test("an ingress service becomes the port: on the shore, outside the ring, on the lattice", () => {
  const addr = firstOf(cityIds[0]!);
  const [cityId, nodeId] = addr.split("/") as [string, string];
  const layout = world([addr]);
  const city = layout.cities.get(cityId)!;
  const harbour = city.harbour;
  expect(harbour).toBeDefined();
  expect(harbour!.berths).toHaveLength(1);

  const berth = harbour!.berths[0]!;
  expect(berth.address).toBe(addr);
  const node = city.nodes.find((n) => n.id === nodeId)!;
  expect(node.isPort).toBe(true);
  // The node IS the berth: `roads/` addresses a building by its cell centre.
  expect([node.position[0], node.position[2]]).toEqual(berth.position);
  // Still on the city's lattice, so its cell centre and its position are one point.
  const [ox, oz] = [
    node.position[0] - berth.cell[0] * PITCH,
    node.position[2] - berth.cell[1] * PITCH,
  ];
  for (const other of city.nodes) {
    expect(Math.abs((other.position[0] - ox) % PITCH)).toBe(0);
    expect(Math.abs((other.position[2] - oz) % PITCH)).toBe(0);
  }

  // On dry land, outside the ring road: the strip the ring leaves to the sea.
  expect(pointInPolygon(berth.position, city.outline)).toBe(true);
  expect(pointInPolygon(berth.position, city.roads.ring)).toBe(false);
  // And its mooring is in the water, off that shore.
  expect(pointInPolygon(berth.dock, city.outline)).toBe(false);
});

test("the port did not push the coast in front of itself", () => {
  const addr = firstOf(cityIds[0]!);
  const [cityId, nodeId] = addr.split("/") as [string, string];
  const city = world([addr]).cities.get(cityId)!;
  const berth = city.harbour!.berths[0]!;
  // It is genuinely on the waterfront — the whole point. Had it stayed in the
  // hull, the shore would have been pushed ISLAND_PADDING further out in front.
  expect(distToPolygon(berth.position, city.outline)).toBeLessThan(2);
  // And no other building is closer to the sea on that side.
  const seaward = city.nodes.filter(
    (n) =>
      n.id !== nodeId &&
      (n.position[0] - berth.position[0]) * (berth.dock[0] - berth.position[0]) +
        (n.position[2] - berth.position[1]) * (berth.dock[1] - berth.position[1]) >
        0,
  );
  for (const n of seaward) {
    expect(distToPolygon([n.position[0], n.position[2]], city.outline)).toBeGreaterThan(
      distToPolygon(berth.position, city.outline),
    );
  }
});

test("the port is served by asphalt", () => {
  const addr = firstOf(cityIds[0]!);
  const cityId = addr.split("/")[0]!;
  const city = world([addr]).cities.get(cityId)!;
  const berth = city.harbour!.berths[0]!;
  const serving = [...city.roads.routes.values()].filter((r) =>
    r.points.some((p) => vecKey(p) === vecKey(berth.position)),
  );
  expect(serving.length).toBeGreaterThan(0);
  // Outside the ring, the quay has no lattice corner: it leaves by an avenue
  // straight onto the ring, and that mouth is a ring vertex, exactly.
  const onRing = new Set(city.roads.ring.map(vecKey));
  const mouths = serving.flatMap((r) => r.points.filter((p) => onRing.has(vecKey(p)))).map(vecKey);
  expect(mouths.length).toBeGreaterThan(0);
  const driveway = city.roads.driveways.find(
    (d) =>
      mouths.includes(vecKey(d.mouth)) &&
      Math.hypot(d.door[0] - berth.position[0], d.door[1] - berth.position[1]) < PITCH / 2,
  );
  expect(driveway).toBeDefined();
  expect(driveway!.klass).toBe("avenue");
});

test("the sea lane of a port crosses no island", () => {
  const addr = firstOf(cityIds[0]!);
  const cityId = addr.split("/")[0]!;
  const layout = world([addr]);
  const islands = [...layout.cities.values()].map((c) => c.outline);
  const harbour = layout.cities.get(cityId)!.harbour!;
  expect(harbour.outside).not.toBeNull();
  const berth = harbour.berths[0]!;
  for (let i = 0; i <= 100; i++) {
    const u = i / 100;
    const p: Vec2 = [
      berth.dock[0] + (harbour.outside![0] - berth.dock[0]) * u,
      berth.dock[1] + (harbour.outside![1] - berth.dock[1]) * u,
    ];
    expect(islands.some((island) => pointInPolygon(p, island))).toBe(false);
  }
});

test("several ingress services share one quay, one berth each", () => {
  const { nodes } = loadWorld(sample as World);
  const cityId = cityIds.find((id) => nodes.filter((n) => n.cityId === id).length >= 4)!;
  const own = nodes.filter((n) => n.cityId === cityId).slice(0, 2);
  const addrs = own.map((n) => `${cityId}/${n.id}`);
  const city = world(addrs).cities.get(cityId)!;
  const harbour = city.harbour!;
  expect(harbour.berths.map((b) => b.address).sort()).toEqual([...addrs].sort());
  const cells = harbour.berths.map((b) => vecKey(b.position));
  expect(new Set(cells).size).toBe(cells.length);
  const [a, b] = harbour.berths as [(typeof harbour.berths)[0], (typeof harbour.berths)[0]];
  expect(
    Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]),
  ).toBeLessThanOrEqual(PITCH * 2.5);
  for (const berth of harbour.berths) {
    expect(city.nodes.find((n) => n.id === berth.nodeId)!.isPort).toBe(true);
  }
});

test("the harbour is deterministic", () => {
  const addr = firstOf(cityIds[0]!);
  const cityId = addr.split("/")[0]!;
  const a = world([addr]).cities.get(cityId)!.harbour!;
  const b = world([addr]).cities.get(cityId)!.harbour!;
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
