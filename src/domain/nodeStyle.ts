import type { LivenessStatus, NodeType } from "./types";

/** One GLB a type can be drawn with, and the scale that brings it to the type's reference height. */
export interface BuildingModel {
  path: string;
  fit: number;
}

/**
 * Pure style constants (no Three.js) shared between DOM panels and the 3D scene.
 *
 * `scale` is the layout's footprint as much as the render size — never vary it
 * per building. `models` are the shapes `buildingVariant()` picks from: the
 * first one is `modelPath`, and every path listed here must exist under
 * `public/models/` (see the README there) or the building never resolves.
 */
export const NODE_STYLE: Record<
  NodeType,
  {
    color: string;
    emissive: string;
    scale: number;
    modelPath: string;
    models: readonly BuildingModel[];
  }
> = {
  app: {
    color: "#4488ff",
    emissive: "#2244aa",
    scale: 1.2,
    modelPath: "/models/app.glb",
    // Skyscrapers b/c/e/m of the same kit, scaled down to skyscraper a's 2.88
    // (4.48 / 4.08 / 4.08 / 3.15 tall). `m` is the squat one: fitted it is only
    // 1.13 wide, so it still turns freely inside the plot.
    models: [
      { path: "/models/app.glb", fit: 1 },
      { path: "/models/app-b.glb", fit: 2.88 / 4.48 },
      { path: "/models/app-c.glb", fit: 2.88 / 4.08 },
      { path: "/models/app-e.glb", fit: 2.88 / 4.08 },
      { path: "/models/app-m.glb", fit: 2.88 / 3.15 },
    ],
  },
  db: {
    color: "#44bb66",
    emissive: "#226633",
    scale: 1.5,
    modelPath: "/models/industrial-warehouse.glb",
    // The three generated hangars, plus two Kenney industrial blocks flattened to
    // the same 0.70 reference height — textured, where the generated ones are
    // vertex-coloured, which is exactly the variety we want in a district.
    models: [
      { path: "/models/industrial-warehouse.glb", fit: 1 },
      { path: "/models/industrial-sheds.glb", fit: 1 },
      { path: "/models/industrial-datacenter.glb", fit: 1 },
      { path: "/models/industrial-kit/building-h.glb", fit: 0.7 / 0.73 },
      { path: "/models/industrial-kit/building-i.glb", fit: 0.7 / 0.73 },
    ],
  },
  cache: {
    color: "#ff8844",
    emissive: "#884422",
    scale: 2.0,
    modelPath: "/models/industrial-depot.glb",
    models: [
      { path: "/models/industrial-depot.glb", fit: 1 },
      { path: "/models/industrial-cold-storage.glb", fit: 1 },
      { path: "/models/industrial-kit/building-k.glb", fit: 0.7 / 0.77 },
    ],
  },
  queue: {
    color: "#aa44ff",
    emissive: "#552288",
    scale: 1.3,
    modelPath: "/models/industrial-terminal.glb",
    models: [
      { path: "/models/industrial-terminal.glb", fit: 1 },
      { path: "/models/industrial-containers.glb", fit: 1 },
      { path: "/models/industrial-kit/building-j.glb", fit: 0.69 / 0.86 },
    ],
  },
};

export const LIVENESS_COLORS: Record<LivenessStatus, string> = {
  healthy: "#44cc66",
  degraded: "#ff9a3c",
  down: "#ff4d5e",
  unknown: "#9aa3b5",
};

export const LIVENESS_TONE: Record<LivenessStatus, "ok" | "warn" | "danger" | "muted"> = {
  healthy: "ok",
  degraded: "warn",
  down: "danger",
  unknown: "muted",
};

export const LINK_COLORS = { intra: "#666688", inter: "#ff4466" } as const;

/**
 * Islands, water, roads and bridges.
 * Y layers: water -0.6 → island 0 → group slabs 0.015 → roads 0.03 → lane dashes 0.035
 * → roundabout disc 0.04 → gauge ring 0.06 → overlays 0.07 → selection ring 0.09
 * (vehicles ride at +0.06).
 */
export const TERRAIN = {
  waterY: -0.6,
  waterColor: "#245189",
  /**
   * The sea near a coast, and the foam on it. Neither is pure white or pure
   * turquoise: the whole frame goes through ACES and a bloom thresholded at
   * 0.8, so a saturated foam would glow like a lamp.
   */
  waterShallow: "#2f6f8f",
  waterFoam: "#c9d9ea",
  /** What the sea reflects at a grazing angle: the night sky, a shade lighter. */
  waterHorizon: "#1b2f55",
  /** Width of the shallow band around an island, in world units — well under WATER_GAP. */
  shoreReach: 6,
  /** Concrete landfill that replaces the beach of an overbuilt island (`CityLayout.crowding` > 1). */
  landfill: "#74747a",
  /** The island's own colours live in `domain/biome.ts`; this is the wall of a roundabout's planted island. */
  islandSide: "#2b2440",
  /**
   * The ground stack, from the island top at y = 0 upwards: neighbourhood slab,
   * asphalt, painted markings, then the raised pavement whose kerb wall drops
   * back to just under the asphalt. Every layer is separated by centimetres
   * rather than millimetres — the depth buffer runs out of precision on a
   * far-away island long before the eye notices the roads sitting that high,
   * and a tie there is what makes the district tint repaint the streets.
   */
  zoneY: 0.03,
  roadY: 0.08,
  /** Asphalt, one shade per road class — the busier the street, the paler. */
  roadColor: "#2e2e4d",
  roadColorAvenue: "#37375c",
  roadColorBoulevard: "#41416b",
  /** Painted markings: pale but under the bloom threshold once faded by their opacity. */
  roadDash: "#8e92b8",
  /** Nominal street width; also the hover-ribbon width of a route overlay. */
  roadWidth: 1.0,
  roadWidthAvenue: 1.5,
  roadWidthBoulevard: 2,
  /** A building's driveway: narrower than a street, it is one lane and a kerb cut. */
  drivewayWidth: 0.9,
  /** Raised pavement along every road: its top, its height, and the kerb wall
   *  below it. The wall is what gives roads an edge against the island, which is
   *  nearly the same value as the tarmac. */
  pavement: "#4b4a6e",
  pavementY: 0.13,
  kerbColor: "#3a3556",
  /** Roundabout centre: a low planted island rather than a hole in the asphalt. */
  roundaboutIsland: "#2e4a44",
  /** Street lighting on avenues and boulevards; the bulb feeds the bloom pass. */
  lampPole: "#3c3858",
  lampLight: "#ffd7a0",
  bridgeDeck: "#2a2a44",
  bridgeMaxRise: 1.2,
} as const;

/**
 * The two models of the harbour: the quay a marked ingress service becomes, and
 * the ships that call at it.
 *
 * `null` on purpose. A GLB that 404s is thrown inside `WorldScene`'s `<Suspense>`
 * and takes the whole scene down with it, so a path is only ever listed here once
 * the file actually sits under `public/models/port/` (with its own `Textures/`;
 * see the README there). Until then both fall back to the procedural geometry of
 * `components/buildings/harbourGeometry.ts`, and switching over is these two
 * strings. Expected orientation: quay façade toward −Z (building convention),
 * ship bow toward +Z (vehicle convention), +Y up, origin centred.
 */
export const PORT_ASSETS: { harbour: string | null; ship: string | null } = {
  harbour: null,
  ship: null,
};

/** Per-instance car tints (trucks stay neutral). */
export const VEHICLE_TINTS = ["#ffffff", "#cdd6ff", "#ffd9b8", "#c8f0dd", "#f2c4d6"] as const;

export function nodeAddress(n: { cityId: string; id: string }): string {
  return `${n.cityId}/${n.id}`;
}
