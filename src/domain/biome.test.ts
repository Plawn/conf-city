import { describe, expect, test } from "bun:test";
import { GraphValidationError, loadWorld } from "../loaders/loadWorld";
import { BIOME_IDS, biomeSource, isBiomeId, resolveBiome, resolveBiomes } from "./biome";
import type { NodeType } from "./types";

const mix = (counts: Partial<Record<NodeType, number>>) =>
  (Object.entries(counts) as [NodeType, number][]).flatMap(([type, n]) =>
    Array.from({ length: n }, () => ({ type })),
  );

describe("resolveBiome", () => {
  test("is deterministic for a given city id and content", () => {
    const nodes = mix({ app: 5, db: 1 });
    expect(resolveBiome({ id: "prod-3" }, nodes)).toBe(resolveBiome({ id: "prod-3" }, nodes));
  });

  test("a database-heavy city is a tundra whatever its id", () => {
    for (const id of ["a", "mini-box-1", "db", "zeta", "prod-eu-west-2"]) {
      expect(resolveBiome({ id }, mix({ db: 7, app: 3 }))).toBe("tundra");
      expect(resolveBiome({ id }, mix({ db: 21, app: 9 }))).toBe("tundra");
    }
  });

  test("caches and queues make dunes", () => {
    for (const id of ["a", "mini-box-1", "zeta"]) {
      expect(resolveBiome({ id }, mix({ cache: 4, queue: 3, app: 3 }))).toBe("dunes");
    }
  });

  test("an empty city is a harbour", () => {
    expect(resolveBiome({ id: "nothing" }, [])).toBe("harbour");
  });

  test("look-alike app-only cities spread over several biomes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(resolveBiome({ id: `mini-box-${i}` }, mix({ app: 6 })));
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    // …but never one that needs a type signal the content does not carry.
    expect(seen.has("tundra")).toBe(false);
    expect(seen.has("dunes")).toBe(false);
  });

  test("JSON beats the provider label, which beats auto", () => {
    const nodes = mix({ db: 10 });
    expect(resolveBiome({ id: "x", biome: "dunes" }, nodes, { biome: "basalt" })).toBe("dunes");
    expect(resolveBiome({ id: "x" }, nodes, { biome: "basalt" })).toBe("basalt");
    expect(resolveBiome({ id: "x" }, nodes)).toBe("tundra");
  });

  test("an unknown label is ignored, not an error", () => {
    expect(resolveBiome({ id: "x" }, mix({ db: 10 }), { biome: "lava" })).toBe("tundra");
    expect(biomeSource({ id: "x" }, { biome: "lava" })).toBe("auto");
    expect(biomeSource({ id: "x" }, { biome: "dunes" })).toBe("label");
    expect(biomeSource({ id: "x", biome: "meadow" }, { biome: "dunes" })).toBe("json");
  });

  test("isBiomeId accepts exactly the known ids", () => {
    for (const id of BIOME_IDS) {
      expect(isBiomeId(id)).toBe(true);
    }
    expect(isBiomeId("lava")).toBe(false);
    expect(isBiomeId(undefined)).toBe(false);
    expect(isBiomeId(3)).toBe(false);
  });
});

describe("resolveBiomes", () => {
  test("groups the nodes by city", () => {
    const cities = [
      { id: "a", name: "A", nodes: [] },
      { id: "b", name: "B", nodes: [] },
    ];
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `d${i}`,
        cityId: "a",
        type: "db" as const,
        label: "",
        links: [],
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`,
        cityId: "b",
        type: "cache" as const,
        label: "",
        links: [],
      })),
    ];
    const out = resolveBiomes(cities, nodes, new Map());
    expect(out.get("a")).toBe("tundra");
    expect(out.get("b")).toBe("dunes");
  });
});

describe("loadWorld", () => {
  test("rejects an unknown biome and names the valid ones", () => {
    const world = { cities: [{ id: "c", name: "C", biome: "lava" as never, nodes: [] }] };
    expect(() => loadWorld(world)).toThrow(GraphValidationError);
    expect(() => loadWorld(world)).toThrow(/lava.*harbour, meadow, dunes, tundra, basalt/);
  });

  test("accepts a known biome", () => {
    expect(() =>
      loadWorld({ cities: [{ id: "c", name: "C", biome: "meadow", nodes: [] }] }),
    ).not.toThrow();
  });
});
