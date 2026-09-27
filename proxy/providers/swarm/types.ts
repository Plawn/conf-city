// Docker Swarm API types, and the topology the provider derives from them.

export interface SwarmNode {
  ID: string;
  Description: {
    Hostname: string;
    Resources: { NanoCPUs: number; MemoryBytes: number };
  };
  Status: { State: string; Addr: string };
  Spec: { Role: string; Labels: Record<string, string> };
}

export interface SwarmService {
  ID: string;
  Spec: {
    Name: string;
    Labels: Record<string, string>;
    TaskTemplate: {
      ContainerSpec: {
        Image: string;
        Labels?: Record<string, string>;
        Env?: string[];
      };
      Resources?: {
        Limits?: { NanoCPUs?: number; MemoryBytes?: number };
        Reservations?: { NanoCPUs?: number; MemoryBytes?: number };
      };
      Networks?: { Target: string }[];
    };
  };
}

export interface SwarmTask {
  ID: string;
  ServiceID: string;
  NodeID: string;
  Status: {
    State: string;
    Timestamp: string;
    ContainerStatus?: { ContainerID: string };
    Message?: string;
    Err?: string;
  };
  DesiredState: string;
  Slot?: number;
}

/** One service on one Swarm node — a building, with what the API told us about it. */
export interface TopologyEntry {
  cityId: string;
  nodeId: string;
  type: string;
  label: string;
  description?: string;
  group?: string;
  hidden: boolean;
  /** Internet entry point (`confcity.ingress`): the service becomes the island's port. */
  ingress: boolean;
  /** Ambient infrastructure (`confcity.ambient`): no link pointing at it is ever drawn. */
  ambient: boolean;
  /** Service names declared via `confcity.links` (resolved to addresses at meta time). */
  linkServices: string[];
  /** The label was present, even empty — inference is disabled for this service. */
  explicitLinks: boolean;
  /** Service names guessed from env vars (used only when no explicit links). */
  inferredLinkServices: string[];
  cpuLimit?: number; // cores
  memLimitMb?: number;
  serviceId: string;
  /** Swarm node id — what log stores carry in `com.docker.swarm.node.id`. */
  swarmNodeId: string;
  containerIds: string[];
  taskStates: string[];
}
