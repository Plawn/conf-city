import type { BiomeId } from "./biome";

export type NodeType = "app" | "db" | "cache" | "queue";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  /** Explicit Internet entry point; its RX drives arrivals at the island port. */
  ingress?: boolean;
  /** Neighbourhood: nodes sharing a group are laid out together on a tinted ground. */
  group?: string;
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

export interface PositionedNode extends ResolvedNode {
  position: [number, number, number];
  isDiscovered?: boolean;
  /** Ingress service moved to the shore: drawn as the island's port, not a building. */
  isPort?: boolean;
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
} from "@proxy/protocol";
