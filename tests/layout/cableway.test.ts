import { describe, expect, test } from "bun:test";
import { cablePoint, cableSpan, MAST_HEIGHT, TOP_STATION_HEIGHT } from "@/layout/cableway";
import { CLOUD_ALTITUDE } from "@/layout/cloud";
import { pointInPolygon } from "@/layout/geometry";
import { layoutWorld } from "@/layout/layoutWorld";
import { city, grid, interLink } from "../fixtures/layout";

const world = (clouds: string[]) =>
  layoutWorld(
    ["a", "groq", "azure"],
    [...grid("a", 3, 2), ...city("groq", ["llm"]), ...city("azure", ["llm"])],
    [
      interLink(["a", "n00"], ["groq", "llm"]),
      interLink(["a", "n21"], ["groq", "llm"]),
      interLink(["groq", "llm"], ["azure", "llm"]),
    ],
    [],
    new Map(),
    new Set(),
    new Map(),
    new Set(clouds),
  );

describe("buildCableways", () => {
  test("an island and its cloud share one cable car, never a bridge", () => {
    const w = world(["groq"]);
    expect(w.bridges.every((b) => b.cityA !== "groq" && b.cityB !== "groq")).toBe(true);
    const ways = w.cableways.filter((c) => c.cloud === "groq" && c.ground === "a");
    expect(ways).toHaveLength(1);
    expect(ways[0]!.links).toHaveLength(2);
  });

  test("the mast stands in the sea off the shore, the hut on the deck", () => {
    const w = world(["groq"]);
    const way = w.cableways[0]!;
    const ground = w.cities.get("a")!;
    const cloud = w.cities.get("groq")!;
    expect(pointInPolygon(way.base, ground.outline)).toBe(false);
    expect(pointInPolygon(way.top, cloud.outline)).toBe(true);
  });

  test("two clouds or two islands get no cable car", () => {
    expect(world(["groq", "azure"]).cableways.map((c) => c.cloud)).toEqual(["groq"]);
    expect(world([]).cableways).toHaveLength(0);
  });
});

describe("cableSpan", () => {
  test("runs from the mast top to the hut and sags under the chord", () => {
    const way = world(["groq"]).cableways[0]!;
    const span = cableSpan(way, 0, 20);
    const last = span.y.length - 1;
    expect(span.y[0]).toBeCloseTo(MAST_HEIGHT);
    expect(span.y[last]).toBeCloseTo(CLOUD_ALTITUDE + TOP_STATION_HEIGHT);
    const mid = (MAST_HEIGHT + CLOUD_ALTITUDE + TOP_STATION_HEIGHT) / 2;
    expect(span.y[10]!).toBeLessThan(mid);
    const p: [number, number, number] = [0, 0, 0];
    cablePoint(span, 1, p);
    expect(p[1]).toBeCloseTo(CLOUD_ALTITUDE + TOP_STATION_HEIGHT);
  });
});

describe("cloud decks", () => {
  test("cloud buildings stand at the deck's altitude, islands at sea level", () => {
    const w = world(["groq"]);
    for (const n of w.nodes) {
      expect(n.position[1]).toBe(n.cityId === "groq" ? CLOUD_ALTITUDE : 0);
    }
  });
});
