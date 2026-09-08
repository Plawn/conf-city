# Conf City

3D infrastructure visualization — each server/cluster is rendered as a **city**, each service as a **building**.

![Stack](https://img.shields.io/badge/React_19-Three.js-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **City metaphor** — clusters/servers become cities, services become buildings
- **Live telemetry** — real-time CPU, memory, RPS, latency, and error rate via WebSocket
- **Liveness indicators** — node color reflects health (healthy / degraded / down)
- **Needs attention** — current incidents across all cities, prioritised by severity, with camera focus and filtered logs; includes failures already present on connection
- **Building fires** — animated flames and smoke for unavailable/degraded services or error rates above 1%; unavailable services burn more intensely, recovery extinguishes the fire, and reduced-motion preferences freeze the effect
- **Auto-discovery** — nodes reported by providers but absent from the static JSON appear automatically as semi-transparent buildings
- **Log viewer** — real-time log panel with level/node filtering
- **Inter-city links** — arcs between cities show cross-cluster dependencies
- **Drag & drop** — load custom infrastructure by dropping a `.json` file
- **Search & filter** — filter nodes by name, toggle city visibility
- **Camera focus** — click a node to smoothly fly to it
- **Office display mode** — 30 fps by default, optional 60 fps, with rendering paused in hidden tabs and a fixed 30 Hz traffic simulation
- **Water** — procedural ripples, broken coastal foam and sky reflections, using the existing textures without a second scene render

The attention list and fires reflect the latest reported telemetry, independently of the alert
history and the active heatmap. Missing, unknown or stale health data (over 30 seconds) does not
produce an all-clear message. When disconnected, the list explicitly shows the last reported
state. Selecting an incident also reveals its city if it was hidden.

The **Office · 30 fps / Smooth · 60 fps** button in the top bar controls the frame ceiling;
the preference survives reloads. Both modes keep the same render resolution. Returning from a
hidden tab resumes animation without replaying the elapsed time. Add `?perf=1` to display actual
fps, time spent in a scene update/render submission and draw calls across the full composed frame.
CPU timings measure scene update/render submission, not operating-system CPU usage. When
available, the GPU value is an asynchronous timestamp observation, reported separately.
The [lighting measurement guide](docs/lighting.md#verification-and-measurement) includes
repeatable camera benchmarks and AO/volume comparisons at a fixed viewport and DPR.
See [rendering performance](docs/render-performance.md) for 30/60 fps qualification,
repeated before/after measurements and larger-world fixtures.

Traffic now has finite journeys, physical lane budgets and gradual jam recovery in one shared simulation. Sustained local queues or high occupancy trigger wider roads, double-deck bridges with widened city accesses, then metro service with pedestrians. Visible countdowns follow real time rather than simulation speed. Roundabouts reserve entry until the exit is clear; waiting for a functioning junction does not trigger emergency removal. Construction persists per world in this browser (`localStorage`); **City evolution** shows progress and provides a local reset.

Mark a service **Internet ingress** in its details, with the `confcity.ingress` Swarm label, or with `"ingress": true` on its JSON node, and the service *becomes* the island's port: it leaves the city block, is placed on the shoreline facing the open sea, and gets its own avenue back to the ring road. Several ingress services on one island share a quay, one berth each. Boats follow each service's received throughput; the fleet is bounded and the RX value may include internal traffic. Toggling the checkbox re-runs the layout, so roads are rebuilt and the traffic pools are emptied. See the [implemented traffic strategy and limits](docs/traffic-strategy.md).

`bun scripts/traffic-soak.ts` checks two 24-hour simulations at 30 Hz for bounded populations and complete drainage. This is an accelerated simulation check, not a 24-hour browser benchmark.

The [building style sheet](docs/building-style.md) is now implemented: three datastore hangars, two cache depots and two queue terminals, alongside the existing application towers. The industrial models are generated locally with `bun scripts/build-industrial-models.ts`.

## Quick start

```sh
bun install          # install dependencies
bun run dev          # start Vite dev server (port 4000)
```

Open [http://localhost:4000](http://localhost:4000) — you'll see the sample infrastructure rendered in 3D.

### With live telemetry

In separate terminals:

```sh
bun run proxy        # start telemetry proxy (port 4001)
bun run dummy        # start dummy data provider (random metrics)
```

The frontend auto-connects to the proxy and displays live metrics on each node.

## Docker deployment

### Site configuration

Everything site-specific (registry, public host, Traefik entrypoint and cert resolver, Swarm
placement, log store) is read from `.env`, which is not committed:

```sh
cp .env.example .env   # then edit
```

The defaults in the compose files run on a single-node box with no external registry.
See [deployment](docs/deployment.md) for the full variable table.

### With Docker Compose

```sh
# Test with dummy provider (random metrics)
docker compose --profile dummy up --build

# Open http://localhost
```

### With Docker Swarm

```sh
docker stack deploy -c docker-compose.yml confcity
```

For the Swarm provider (real Docker Swarm metrics), use the `swarm` profile or deploy the `provider-swarm` service. It needs access to the Docker socket and must run on a manager node.

### Services

| Service | Image | Port | Description |
|---|---|---|---|
| `frontend` | nginx | 80 | Serves SPA + proxies `/ws/` and `/api/` to proxy |
| `proxy` | bun | 4001 (internal) | WebSocket hub: collects from providers, broadcasts to frontends |
| `provider-dummy` | bun | — | Random walk metrics generator for testing |
| `provider-swarm` | bun | — | Real metrics from Docker Swarm API |

### Environment variables

| Variable | Service | Default | Description |
|---|---|---|---|
| `PROXY_PORT` | proxy | `4001` | Port the proxy listens on |
| `PROXY_URL` | providers | `ws://proxy:4001/ws/provider` | WebSocket URL to connect to the proxy |
| `PROVIDER_ID` | provider-swarm | `swarm-provider` | Provider identifier |
| `DOCKER_HOST` | provider-swarm | `/var/run/docker.sock` | Docker API endpoint |
| `SWARM_TOPOLOGY_INTERVAL` | provider-swarm | `30000` | Topology refresh interval (ms) |
| `SWARM_METRICS_INTERVAL` | provider-swarm | `5000` | Metrics collection interval (ms) |
| `SWARM_LIVENESS_INTERVAL` | provider-swarm | `5000` | Liveness check interval (ms) |
| `SWARM_LOGS_INTERVAL` | provider-swarm | `3000` | Log collection interval (ms) |
| `VITE_PROXY_URL` | frontend (build-time) | auto-detect | Override the WebSocket URL the frontend connects to |

## Commands

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `bun install`       | Install dependencies                 |
| `bun run dev`       | Vite dev server (port 4000)          |
| `bun run build`     | Production build to `dist/`          |
| `bun run lint`      | Check formatting, lint and imports    |
| `bun run lint:fix`  | Apply all Biome fixes, including braces |
| `bun run format`    | Format supported project files        |
| `bun run preview`   | Preview production build             |
| `bun run proxy`     | Telemetry proxy (port 4001)          |
| `bun run dummy`     | Dummy data provider for testing      |

## Architecture

```
                              ┌─────────────────────────────┐
                              │         Frontend            │
                              │  React 19 + Three.js + R3F  │
                              │        port 80 (nginx)      │
                              └──────────┬──────────────────┘
                                         │ WebSocket
                              ┌──────────▼──────────────────┐
                              │       Proxy (Bun)           │
                              │  WebSocket hub, port 4001   │
                              │  Snapshot + delta broadcast  │
                              │  Log forwarding with filter  │
                              └──────────┬──────────────────┘
                                         │ WebSocket
                     ┌───────────────────┼───────────────────┐
                     ▼                   ▼                   ▼
              ┌─────────────┐   ┌───────────────┐   ┌──────────────┐
              │   Dummy      │   │ Docker Swarm  │   │  Your own    │
              │   Provider   │   │   Provider    │   │  provider    │
              └─────────────┘   └───────────────┘   └──────────────┘
```

- **Frontend** — React 19 + `@react-three/fiber` + `@react-three/drei`, styled with Tailwind CSS v4
- **Proxy** — Bun WebSocket server that collects telemetry from providers and broadcasts to frontends
- **Providers** — pluggable data sources (dummy random walk, Docker Swarm API, or custom)

## Infrastructure JSON format

```json
{
  "cities": [
    {
      "id": "paris-1",
      "name": "Paris 1",
      "nodes": [
        { "id": "api", "type": "app", "label": "API Gateway", "links": ["db", "cache"] },
        { "id": "db", "type": "db", "label": "PostgreSQL", "links": [] },
        { "id": "cache", "type": "cache", "label": "Redis", "links": [] }
      ]
    }
  ],
  "links": [
    { "from": "paris-1/api", "to": "london-1/analytics-api", "label": "Event stream" }
  ]
}
```

### Node types

| Type    | 3D Model         | Color     | Use for |
| ------- | ---------------- | --------- | ------- |
| `app`   | Skyscraper       | `#4488ff` | Web servers, APIs, workers |
| `db`    | Industrial tank  | `#44bb66` | Databases (Postgres, Mongo, etc.) |
| `cache` | Computer screen  | `#ff8844` | Caches (Redis, Memcached) |
| `queue` | Chimney          | `#aa44ff` | Message queues (Kafka, RabbitMQ) |

### Node addressing

Nodes are addressed as `"cityId/nodeId"` everywhere: telemetry keys, log entries, inter-city links. This is the universal identifier.

## WebSocket protocol

All communication uses JSON over WebSocket. Types are defined in `proxy/protocol.ts`.

### Provider -> Proxy

| Message | Description |
|---|---|
| `provider:hello` | Register with id, type, and capabilities |
| `provider:metrics` | `Record<address, MetricSnapshot>` |
| `provider:liveness` | `Record<address, LivenessStatus>` |
| `provider:logs` | `LogEntry[]` |
| `provider:node-meta` | `Record<address, NodeMeta>` — node type and label for auto-discovery |

### Proxy -> Frontend

| Message | Description |
|---|---|
| `snapshot` | Full state: all nodes telemetry + metadata. Sent on connect and every 5s |
| `update` | Delta: only changed nodes since last flush. Sent every 1s |
| `logs` | Filtered log entries (only if frontend subscribed) |
| `status` | List of connected providers |

### Frontend -> Proxy

| Message | Description |
|---|---|
| `subscribe:logs` | Start receiving logs, optional node/level filters |
| `unsubscribe:logs` | Stop receiving logs |
| `request:snapshot` | Request a fresh snapshot |

### Key types

```typescript
type LivenessStatus = "healthy" | "degraded" | "down" | "unknown";

interface MetricSnapshot {
  cpu?: number;        // 0-100
  memoryMb?: number;
  rps?: number;
  latencyMs?: number;
  errorRate?: number;  // 0-1
  custom?: Record<string, number>;
}

interface NodeTelemetry {
  liveness: LivenessStatus;
  metrics: MetricSnapshot;
  lastSeen: number;    // epoch ms
}

interface NodeMeta {
  type: string;        // "app" | "db" | "cache" | "queue"
  label?: string;
}

interface LogEntry {
  timestamp: number;
  node: string;        // "cityId/nodeId"
  level: "debug" | "info" | "warn" | "error";
  message: string;
}
```

## Writing a custom provider

Create a new file in `proxy/providers/` and use `BaseProvider`:

```ts
import { BaseProvider } from "./base.ts";
import type { MetricSnapshot, LivenessStatus, NodeMeta } from "../protocol.ts";

const provider = new BaseProvider({
  id: "my-provider",
  type: "my-system",
  capabilities: ["metrics", "liveness", "logs"],

  // Option 1: interval-based collectors (sync functions)
  intervals: {
    metrics: {
      ms: 5_000,
      collect: (): Record<string, MetricSnapshot> => {
        return {
          "my-cluster/api": { cpu: 42, memoryMb: 512 },
          "my-cluster/db":  { cpu: 20, memoryMb: 2048 },
        };
      },
    },
    liveness: {
      ms: 10_000,
      collect: (): Record<string, LivenessStatus> => {
        return {
          "my-cluster/api": "healthy",
          "my-cluster/db":  "healthy",
        };
      },
    },
  },

  // Send node metadata on connect (enables auto-discovery)
  onConnected: () => {
    provider.sendNodeMeta({
      "my-cluster/api": { type: "app", label: "API Gateway" },
      "my-cluster/db":  { type: "db",  label: "PostgreSQL" },
    });
  },
});

provider.start();
```

### BaseProvider API

| Method | Description |
|---|---|
| `start()` | Connect to proxy and begin sending data |
| `stop()` | Disconnect and stop all intervals |
| `sendMetrics(nodes)` | Push metrics manually (outside intervals) |
| `sendLiveness(nodes)` | Push liveness manually |
| `sendLogs(entries)` | Push log entries |
| `sendNodeMeta(nodes)` | Push node metadata (type + label) |
| `connected` | `boolean` — whether currently connected |

### Config options

| Option | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | required | Unique provider identifier |
| `type` | `string` | required | Provider type name |
| `capabilities` | `string[]` | required | What this provider sends |
| `proxyUrl` | `string` | `ws://localhost:4001/ws/provider` | Proxy WebSocket URL (also reads `PROXY_URL` env) |
| `reconnectMs` | `number` | `3000` | Delay before reconnecting |
| `intervals` | `object` | — | Auto-running collectors (metrics, liveness, logs) |
| `onConnected` | `() => void` | — | Callback when connected to proxy |
| `onDisconnected` | `() => void` | — | Callback when disconnected |

### Auto-discovery

If a provider sends telemetry for node addresses not present in the frontend's static JSON, those nodes are **automatically rendered** as semi-transparent buildings. The `sendNodeMeta()` call tells the frontend what type and label to use for each discovered node. Without metadata, discovered nodes default to type `"app"`.

## Proxy REST endpoints

The proxy also exposes HTTP endpoints for debugging:

| Endpoint | Description |
|---|---|
| `GET /health` | `{ ok: true, uptime: <seconds> }` |
| `GET /api/state` | Current state: all nodes, providers, log count |

## Lighting

The **Sun & lighting** panel controls the real-time sun (Paris by default) and local-date previews. See [lighting architecture, controls and validation](docs/lighting.md) for WebGPU/WebGL2 behavior and reproducible visual/performance checks.

## License

MIT
