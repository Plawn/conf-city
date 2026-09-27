import { fnv1a, mulberry32 } from "../lib/random";
import type { City, CityMeta, NodeType, ResolvedNode } from "./types";

/**
 * Biomes: what makes one island look unlike the next.
 *
 * A biome is a palette plus a few procedural knobs — how jagged the coast is,
 * how much of the slope is beach, what the vegetation will be, how the
 * buildings' type colours are tinted. It is chosen for the city, never for a
 * building, and resolved once, in the domain: the layout reads `ruggedness`,
 * the renderer reads the colours, nothing in between guesses.
 *
 * Every colour stays well under the bloom threshold (≤ `#7a` per channel, sea
 * excepted) and desaturated enough that the pastel neighbourhood slabs and the
 * liveness colours still read on top of it.
 */

export const BIOME_IDS = ["harbour", "meadow", "dunes", "tundra", "basalt"] as const;
export type BiomeId = (typeof BIOME_IDS)[number];

export function isBiomeId(s: unknown): s is BiomeId {
  return typeof s === "string" && (BIOME_IDS as readonly string[]).includes(s);
}

/** Vegetation and props a biome scatters on its free land (phase 4). */
export type PropKind = "tree" | "pine" | "palm" | "rock" | "tuft";

export interface Biome {
  id: BiomeId;
  label: string;
  /** Island top — the plateau every building stands on. */
  ground: string;
  /** The wall under the beach, mostly under water. */
  cliff: string;
  /** Beach: the coloured band on the shore slope. */
  sand: string;
  /** Share of the slope (top → waterline) painted sand, 0..1. `1` = the whole slope. */
  sandBand: number;
  /** Coastline noise amplitude, 0..1 — `0` is the exact rounded offset of the hull. */
  ruggedness: number;
  /**
   * Vegetation: colours, what grows, and how densely it is *sampled* — one
   * candidate per `100 / density` world units², before the roads, the plots and
   * the shore margin take their share (on a real island they reject well over
   * half).
   *
   * These started as placeholders an order of magnitude too low. At `1` the
   * sampling grid is 10 units wide — wider than the gaps a PITCH-6 city leaves
   * between its buildings, and a third of an island's whole width — so nearly
   * every candidate fell on a road or a plot and an island grew two trees. They
   * are now set from what actually reads on screen.
   */
  canopy: string;
  trunk: string;
  rock: string;
  density: number;
  kinds: readonly PropKind[];
  /** Buildings, health mode only: HSL deltas applied around `NODE_STYLE[type].color`. */
  tint: { hue: number; sat: number; light: number };
  /** Sea near the coast (phase 5, per-island water). */
  waterShallow: string;
  waterFoam: string;
}

/** What the island mesh needs — a biome minus everything that is not ground. */
export type IslandPalette = Pick<Biome, "ground" | "cliff" | "sand" | "sandBand">;

export const BIOMES: Record<BiomeId, Biome> = {
  /** The look the scene had before biomes: dark slate, a hint of shore. The default. */
  harbour: {
    id: "harbour",
    label: "Harbour",
    ground: "#1a1a2e",
    cliff: "#2b2440",
    sand: "#4d4759",
    sandBand: 0.5,
    ruggedness: 0.25,
    canopy: "#2f4d46",
    trunk: "#3a3348",
    rock: "#3c3850",
    density: 8,
    kinds: ["tree", "tuft"],
    tint: { hue: 0, sat: 0, light: 0 },
    waterShallow: "#2f6f8f",
    waterFoam: "#c9d9ea",
  },
  /** Green plateau, soft coast, warm sand — where the web tier tends to live. */
  meadow: {
    id: "meadow",
    label: "Meadow",
    ground: "#1b2a25",
    cliff: "#27293d",
    sand: "#6b6250",
    sandBand: 0.6,
    ruggedness: 0.4,
    canopy: "#3b6a45",
    trunk: "#4a3a2c",
    rock: "#4a4d52",
    density: 20,
    kinds: ["tree", "tuft"],
    tint: { hue: -6, sat: 0.04, light: 0.02 },
    waterShallow: "#2f7f86",
    waterFoam: "#cfe0e6",
  },
  /** Ochre ground, the whole slope is beach — caches and queues, hot and dry. */
  dunes: {
    id: "dunes",
    label: "Dunes",
    ground: "#2a2420",
    cliff: "#3a2c28",
    sand: "#7a6a4e",
    sandBand: 1,
    ruggedness: 0.6,
    canopy: "#3f6a48",
    trunk: "#5a4634",
    rock: "#5c5044",
    density: 7,
    kinds: ["palm", "rock"],
    tint: { hue: 8, sat: 0.05, light: 0.03 },
    waterShallow: "#2f8a8a",
    waterFoam: "#d6e6e4",
  },
  /** Cold blue-grey, jagged shore, pines — databases, heavy and still. */
  tundra: {
    id: "tundra",
    label: "Tundra",
    ground: "#1e2430",
    cliff: "#2a3040",
    sand: "#545b6c",
    sandBand: 0.4,
    ruggedness: 0.75,
    canopy: "#24483f",
    trunk: "#3b3030",
    rock: "#4b515e",
    density: 15,
    kinds: ["pine", "rock"],
    tint: { hue: 6, sat: -0.08, light: -0.02 },
    waterShallow: "#2f5f8f",
    waterFoam: "#c9d9ea",
  },
  /** Dark volcanic rock, the most broken coast — a dense metropolis. */
  basalt: {
    id: "basalt",
    label: "Basalt",
    ground: "#211c24",
    cliff: "#2e2230",
    sand: "#3a3138",
    sandBand: 0.3,
    ruggedness: 0.9,
    canopy: "#4a3b3b",
    trunk: "#2e2626",
    rock: "#3a3036",
    density: 6,
    kinds: ["rock", "tuft"],
    tint: { hue: -4, sat: -0.05, light: -0.04 },
    waterShallow: "#3d5a7a",
    waterFoam: "#b8c4d6",
  },
};

export const DEFAULT_BIOME: BiomeId = "harbour";

export type BiomeSource = "json" | "label" | "auto";

/** Where a city's biome comes from: the world JSON, a provider label, or the content. */
export function biomeSource(
  city: { id: string; biome?: string },
  meta?: { biome?: string },
): BiomeSource {
  if (isBiomeId(city.biome)) {
    return "json";
  }
  if (isBiomeId(meta?.biome)) {
    return "label";
  }
  return "auto";
}

/**
 * The biome of one city: explicit in the JSON, else the provider's label, else
 * deduced from what the island holds.
 *
 * Auto mode scores every biome from the type mix — databases pull towards
 * tundra, caches and queues towards dunes, a big city towards basalt — and adds
 * a jitter seeded on the city id. The jitter is smaller than a decisive
 * histogram and larger than an indecisive one, so a cluster of look-alike
 * `app`-only nodes still spreads over meadow, harbour and basalt instead of
 * five identical meadows, while a database box is always a tundra.
 */
export function resolveBiome(
  city: { id: string; biome?: string },
  nodes: readonly { type: NodeType }[],
  meta?: { biome?: string },
): BiomeId {
  if (isBiomeId(city.biome)) {
    return city.biome;
  }
  if (isBiomeId(meta?.biome)) {
    return meta.biome;
  }

  const n = nodes.length;
  if (n === 0) {
    return DEFAULT_BIOME;
  }
  const count: Record<NodeType, number> = { app: 0, db: 0, cache: 0, queue: 0 };
  for (const node of nodes) {
    count[node.type]++;
  }
  const f = (t: NodeType) => count[t] / n;

  const score: Record<BiomeId, number> = {
    harbour: 0.5,
    meadow: 0.6 * f("app"),
    dunes: 2 * (f("cache") + f("queue")),
    tundra: 2 * f("db"),
    basalt: 0.6 * Math.min(1, n / 16),
  };
  const rand = mulberry32(fnv1a(`${city.id}|biome`));
  let best: BiomeId = DEFAULT_BIOME;
  let bestScore = -Infinity;
  for (const id of BIOME_IDS) {
    const s = score[id] + rand() * 0.6;
    if (s > bestScore) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

/** `resolveBiome` for every city of the world, nodes grouped by city. */
export function resolveBiomes(
  cities: readonly City[],
  nodes: readonly ResolvedNode[],
  cityMeta: ReadonlyMap<string, CityMeta>,
): Map<string, BiomeId> {
  const byCity = new Map<string, ResolvedNode[]>();
  for (const node of nodes) {
    const list = byCity.get(node.cityId);
    if (list) {
      list.push(node);
    } else {
      byCity.set(node.cityId, [node]);
    }
  }
  const out = new Map<string, BiomeId>();
  for (const city of cities) {
    out.set(city.id, resolveBiome(city, byCity.get(city.id) ?? [], cityMeta.get(city.id)));
  }
  return out;
}
