import type { NodeType } from "@proxy/protocol";
import type { BiomeId } from "./biome";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  /** Explicit Internet entry point; its RX drives arrivals at the island port. */
  ingress?: boolean;
  /** Neighbourhood: nodes sharing a group are laid out together on a tinted ground. */
  group?: string;
  /** Requested look, a `BUILDING_KINDS` id; ignored when unknown or meant for another type. */
  building?: string;
  links: string[];
}

export interface InterCityLink {
  from: string; // "cityId/nodeId"
  to: string; // "cityId/nodeId"
  label?: string;
}

export interface City {
  id: string;
  name: string;
  description?: string;
  /** Look of the island, chosen by hand; omitted = deduced from the content (see `domain/biome.ts`). */
  biome?: BiomeId;
  /** A managed cloud service, drawn as a floating island above the sea: no streets, no shore. */
  cloud?: boolean;
  nodes: GraphNode[];
}

export interface World {
  cities: City[];
  links?: InterCityLink[];
}

export interface ResolvedNode extends GraphNode {
  cityId: string;
}

export interface ResolvedLink {
  fromNodeId: string;
  fromCityId: string;
  toNodeId: string;
  toCityId: string;
  interCity: boolean;
  label?: string;
  /** Link guessed by a provider (env vars…) rather than declared. */
  inferred?: boolean;
}

/** A node known only from telemetry, not from the static graph. */
export interface DiscoveredResolvedNode extends ResolvedNode {
  isDiscovered: true;
}

export interface PositionedNode extends ResolvedNode {
  /** World coordinates; y is the deck the building stands on (sea level, or a cloud's platform). */
  position: [number, number, number];
  isDiscovered?: boolean;
  /** Ingress service moved to the shore: drawn as the island's port, not a building. */
  isPort?: boolean;
  /** Where the building sits in its lattice plot (`layout/plotSettle.ts`); absent for ports and clouds. */
  plot?: PlotSettle;
}

/** A building's settle in its plot: off the plot centre, turned to its street. */
export interface PlotSettle {
  /** Shift from `position`, x/z world units. */
  offset: [number, number];
  /** Rotation about y; the model's front (−Z) faces its street. */
  yaw: number;
  /** Neighbourhood big enough to read as a district: one palette for all its buildings. */
  district?: string;
  /** Height multiplier: a district's core rises into a skyline. */
  rise?: number;
  /** A lot of several cells: the building stands mid-lot, stretched to fill it. */
  lot?: {
    /** Each lot cell's centre, relative to `position`. */
    cells: [number, number][];
    /** Model stretch: x along its front, z its depth. */
    stretch: [number, number];
  };
}

// Re-export telemetry types from the canonical source (proxy/protocol.ts)
export type {
  CityMeta,
  CityMetrics,
  LivenessStatus,
  LogEntry,
  MetricSnapshot,
  NodeMeta,
  NodeTelemetry,
  NodeType,
} from "@proxy/protocol";
