# Providers & the proxy

A provider collects telemetry from one system and pushes it to the proxy over a WebSocket; the
proxy merges every provider into one `TelemetryStore` and broadcasts to the frontends. Message
types are in `proxy/protocol.ts` (imported by the frontend through the `@proxy/` alias); the
message flow is summarised in `architecture.md`.

## Provider API

`BaseProvider` in `proxy/providers/base.ts`:

```ts
const provider = new BaseProvider({
  id: "my-provider",
  type: "my-system",
  capabilities: ["metrics", "liveness", "logs"],
  proxyUrl: "ws://localhost:4001/ws/provider",  // or PROXY_URL env
  intervals: {
    metrics:  { ms: 5000,  collect: () => ({ "city/node": { cpu: 42 } }) },
    liveness: { ms: 10000, collect: () => ({ "city/node": "healthy" }) },
    logs:     { ms: 3000,  collect: () => [{ timestamp: Date.now(), node: "city/node", level: "info", message: "ok" }] },
  },
  onConnected: () => {
    provider.sendNodeMeta(
      { "city/node": { type: "app", label: "My Service", group: "web", links: ["city/db"] } },
      { city: { cpuCores: 8, memMb: 16384 } },
    );
  },
});
provider.start();
```

Push methods: `sendMetrics()`, `sendLiveness()`, `sendLogs()`, `sendNodeMeta()`.

`onQueryLogs?: (q) => Promise<LogEntry[]>` answers historical range queries; declare the
`logs-query` capability alongside it or the proxy never routes one here.

Node addresses are always `"cityId/nodeId"` (e.g. `"production/api-gateway"`).

## Log backfill

`query:logs` is fanned out to every provider declaring `logs-query`; the answers are merged,
deduplicated by `logKey` and sorted before reaching the frontend. With no such provider the proxy
answers from its own ring buffer (`fromCache: true`). A queried provider must always answer, even
to report an error, or the proxy waits out its 12 s timeout — `BaseProvider` guarantees this.
Timeouts cascade: source 10 s < proxy 12 s < frontend 15 s. Backends: `logs-backends.md`.

## Swarm: two complementary providers

`/containers/{id}/stats` only answers for containers of the **local** daemon, so a manager-side
provider is blind to every task scheduled on another node. Coverage is split, and
`TelemetryStore.applyMetrics()` merges both into the same address field by field:

| | placement | writes |
|---|---|---|
| `docker-swarm.ts` | `node.role == manager` | topology, `NodeMeta`, `CityMeta`, liveness, logs, `cpuLimit` / `memLimitMb` |
| `docker-node.ts` | `mode: global` (every node) | `cpu`, `memoryMb`, `netRxKbps`, `netTxKbps`, and the machine's own `CityMetrics` |
| *or* `victoria.ts` | one replica, anywhere | the same fields, read from VictoriaMetrics |

The two **must keep writing disjoint fields** — the merge is last-writer-wins per key, so an
overlap would make values flap between providers. Limits stay on the manager because they come
from the service spec (`Reservations` serve as a fallback when no hard limit is set) and are scaled
by the replica count running on that node, matching the usage the agent sums over those replicas.

Host mounts and `PROVIDER_ID` templating: `deployment.md`. Service labels: `swarm-labels.md`.

### VictoriaMetrics instead of the agent

Where Telegraf (`docker` input) and node_exporter already ship to VictoriaMetrics, `victoria.ts`
replaces the agent: one PromQL instant query per field per tick, for the whole cluster, no Docker
socket and no host mount. It writes exactly the agent's fields, so **deploy one or the other**
(`docker-compose.victoria.yml` or `docker-compose.node-agent.yml`), never both.

| field | query (`C` = container matchers, `N` = node matchers, `w` = window) |
|---|---|
| `cpu` | `sum by (host, service)(rate(docker_container_cpu_usage_total{C,cpu="cpu-total"}[w])) / 1e7` |
| `memoryMb` | `docker_container_mem_usage - docker_container_mem_inactive_file`, summed |
| `netRxKbps` / `netTxKbps` | `rate(docker_container_net_{rx,tx}_bytes[w]) * 8 / 1000`, summed over interfaces |
| `cpuUsedCores` | `rate(node_cpu_seconds_total{N,mode!~"idle\|iowait"}[w])`, summed |
| `memUsedMb` | `MemTotal - MemAvailable` |
| `load1` | `node_load1` |
| `diskUsedMb` / `diskTotalMb` | `node_filesystem_{size - free, size}` on the root mountpoint |
| `diskRead/WriteMbPerSec` | `rate(node_disk_{read,written}_bytes_total[w])` over whole disks |

Addresses come from labels: `engine_host/com_docker_swarm_service_name` for services, `instance`
for machines — both must be the Swarm hostname. `CityMetrics.at` is the sample time, not the poll
time. A failed query drops only its field for that tick (warned once, until it recovers).

| variable | default | meaning |
|---|---|---|
| `VICTORIAMETRICS_URL` | `http://victoriametrics:8428` | Prometheus API base (`/api/v1/query` is appended) |
| `VICTORIAMETRICS_TIMEOUT_MS` | `8000` | deadline per query |
| `VM_METRICS_INTERVAL` | `10000` | poll period — no use going below the scrape interval |
| `VM_RATE_WINDOW` | `30s` | `rate()` window, a few scrape intervals |
| `VM_CONTAINER_FILTER` | `job="telegraf"` | matchers for the container series |
| `VM_NODE_FILTER` | `job="node"` | matchers for the node_exporter series |
| `VM_HOST_LABEL` / `VM_SERVICE_LABEL` | `engine_host` / `com_docker_swarm_service_name` | container address labels |
| `VM_INSTANCE_LABEL` | `instance` | machine address label |
| `VM_ROOT_MOUNT` | `/` | mountpoint measured for disk space |
| `VM_DISK_DEVICE_EXCLUDE` | `(loop\|ram\|zram\|sr\|fd\|dm-\|md).*` | devices left out of disk throughput |

## Auto-discovery

When telemetry arrives for addresses absent from the frontend's static JSON:

1. `useTelemetryStream` bumps `telemetryKeysVersion` (new keys only) and keeps `nodeMeta` /
   `cityMeta` Map identity unless an entry really changed (`reconcileMeta`).
2. `buildDiscoveredNodes()` diffs telemetry keys against known addresses.
3. `layoutWorld()` places them in a discovery zone just south (+Z) of the city's static block; the
   ring road and the island grow around them, an unlinked node gets its own spur to the ring.
4. New cities are created when the cityId does not exist in the JSON.
5. Discovered nodes render semi-transparent (0.75) with a "discovered" tag in the tooltip.
6. `NodeMeta` decides type, label, description, `group`, `links` (full addresses, `inferred` flag),
   `hidden` (dropped from scene, counts, alerts) and `ingress`.
7. The city's biome (`CityMeta.biome`, node label `confcity.biome`) is resolved in `App`; auto mode
   re-scores when the type mix changes, so a discovered city may change look as it fills up.
