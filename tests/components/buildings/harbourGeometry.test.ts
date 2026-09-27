import { expect, test } from "bun:test";
import { harbourGeometry, shipGeometry } from "@/components/buildings/harbourGeometry";

/** Every vertex of the merged buffer, as flat arrays — the only thing worth asserting. */
function axes(g: ReturnType<typeof harbourGeometry>) {
  const p = g.getAttribute("position");
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < p.count; i++) {
    xs.push(p.getX(i));
    ys.push(p.getY(i));
    zs.push(p.getZ(i));
  }
  return { xs, ys, zs, count: p.count };
}

test("the quay is vertex-coloured, sits on the ground, and faces the sea at -Z", () => {
  const g = harbourGeometry();
  const { xs, zs, count } = axes(g);
  expect(g.getAttribute("color").count).toBe(count);
  // Standing on the island top (y = 0), reference height of a building model.
  expect(g.boundingBox!.min.y).toBeCloseTo(0, 5);
  expect(g.boundingBox!.max.y).toBeLessThan(1);
  // Centred on the plot in X — the quay runs along the shore.
  expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2)).toBeLessThan(0.1);
  // The cranes reach over the water, so the model overhangs toward -Z, and the
  // yard (sheds, containers) sits landward: the seaward face is unambiguous.
  expect(Math.min(...zs)).toBeLessThan(-0.6);
  const seaward = zs.filter((z) => z < -0.45).length;
  expect(seaward).toBeGreaterThan(0);
  g.dispose();
});

test("the ship is vertex-coloured, floats at y = 0, and points its bow at +Z", () => {
  const g = shipGeometry();
  const { zs, count } = axes(g);
  expect(g.getAttribute("color").count).toBe(count);
  // The waterline is the origin: the hull dips below, the cargo rides above.
  expect(g.boundingBox!.min.y).toBeLessThan(0);
  expect(g.boundingBox!.max.y).toBeGreaterThan(0.5);
  // Longer than it is wide, and the hull's forward end is the wedge at +Z.
  const box = g.boundingBox!;
  expect(box.max.z - box.min.z).toBeGreaterThan(box.max.x - box.min.x);
  const bow = Math.max(...zs);
  const stern = Math.min(...zs);
  // The wedge narrows: at the very bow only the centreline survives.
  const atBow = new Set<number>();
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) > bow - 1e-6) {
      atBow.add(Math.round(p.getX(i) * 1000));
    }
  }
  expect(atBow.size).toBe(1);
  expect(bow).toBeGreaterThan(Math.abs(stern) - 0.5);
  g.dispose();
});
