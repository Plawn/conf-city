# Docker Swarm labels & what the city shows

Conf City discovers every Swarm service automatically (one building per service
per node, one city per Swarm node). Labels on the service refine what is
displayed; resource limits in the stack file drive the saturation visuals.

## Labels

Put them under `deploy.labels` (service labels) — container labels
(`labels:` at the service root) work too and win when both are set.

| Label                  | Values                                    | Effect |
|------------------------|-------------------------------------------|--------|
| `confcity.type`        | `app` \| `db` \| `cache` \| `queue`        | Building model & colour. Without it the type is guessed from the image name (`postgres`, `redis`, `rabbitmq`…), default `app`. |
| `confcity.label`       | free text                                 | Display name (default: service name). |
| `confcity.description` | free text                                 | Shown in the tooltip and the detail drawer. |
| `confcity.group`       | free text, e.g. `web`, `data`, `jobs`     | Neighbourhood: buildings sharing a group are laid out together on a tinted slab with the group name. |
| `confcity.links`       | comma-separated **Swarm service names**   | Outgoing dependencies (`api` → `db`). Resolved to the replica on the same node when there is one, otherwise to every node running the target (drawn as an inter-city arc). Unknown names are logged and ignored. |
| `confcity.hidden`      | `true` / `1` / `yes`                      | Never rendered (node agents, exporters, log shippers…). Also excluded from counts, alerts and rankings. |
| `confcity.ingress`     | `true` / `1` / `yes`                      | Internet entry point (traefik, nginx, an API gateway): the service **is** the island's port. It leaves the city block, is placed on the shoreline facing the open sea, gets its own avenue to the ring road, and cargo ships call at its berth at a rate driven by its `netRxKbps`. Several ingress services on one island share a quay, one berth each. |
| `confcity.ambient`     | `true` / `1` / `yes`                      | Ambient infrastructure (auth server, log store…): the building stays, but **no link pointing at it is drawn**, declared or inferred — everyone talks to it, so the star of roads teaches nothing. Its own outgoing links are unaffected. Also settable without touching the service: `AMBIENT_SERVICES` (comma-separated service names) on the provider. |

When a service has **no** `confcity.links` label, the provider tries to infer
links from the container environment: any env value containing another service
name (`DATABASE_URL=postgres://db:5432/app`, `REDIS_HOST=cache`) becomes a link
drawn thinner and tagged *inferred* in its tooltip. Declare `confcity.links`
(even empty: `confcity.links=`) to take control — the label's presence alone
disables inference for that service.

Inference ignores **hubs**: a target inferred by at least 3 services *and* by
40 % of all services is treated as ambient infrastructure (an auth server, a
log store — everyone carries its URL) and no inferred link is drawn to it, or
the real topology would drown under the star of roads. The building itself
stays; declare `confcity.links: keycloak` on a service to keep an explicit
link to a hub.

### Example stack

```yaml
services:
  api:
    image: registry.example.com/shop/api:1.4
    environment:
      DATABASE_URL: postgres://db:5432/shop
      REDIS_URL: redis://cache:6379
    deploy:
      resources:
        limits:   { cpus: "2",   memory: 1G }
        reservations: { cpus: "0.5", memory: 256M }
      labels:
        confcity.type: app
        confcity.label: Shop API
        confcity.description: REST API for the storefront
        confcity.group: web
        confcity.links: db,cache,events

  db:
    image: postgres:16
    deploy:
      resources:
        limits: { cpus: "4", memory: 4G }
      labels:
        confcity.type: db
        confcity.label: PostgreSQL
        confcity.group: data

  cache:
    image: redis:7
    deploy:
      resources:
        limits: { cpus: "1", memory: 512M }
      labels:
        confcity.group: data          # type guessed from the image → cache

  events:
    image: rabbitmq:3-management
    deploy:
      labels:
        confcity.type: queue
        confcity.group: jobs
        confcity.links: worker

  worker:
    image: registry.example.com/shop/worker:1.4
    deploy:
      labels:
        confcity.group: jobs
        confcity.links: db

  node-exporter:
    image: prom/node-exporter
    deploy:
      mode: global
      labels:
        confcity.hidden: "true"
```

Labels are picked up on the next topology refresh (every 30 s) — no restart
of the proxy or the provider needed.

## Node labels

Cities are Swarm **nodes**, so what describes the island lives on the node, not on a
service:

```sh
docker node update --label-add confcity.biome=dunes <node>
```

| Label | Values | Effect |
|-------|--------|--------|
| `confcity.biome` | `harbour` `meadow` `dunes` `tundra` `basalt` | Look of the island: ground and beach colours, how ragged the coast is, the tint of its buildings. Unknown values are ignored. |

Without the label the biome is **deduced from the content**: databases pull towards
`tundra`, caches and queues towards `dunes`, plain web tiers spread over `meadow`,
`harbour` and (for big cities) `basalt`, with a stable per-node tie-break so look-alike
nodes still differ. The label is read on the manager's topology refresh (every 30 s) and
wins over the deduction; a `biome` set in the world JSON wins over both. The Cities panel
shows the biome after the name and, on hover, where it came from.

## Resource limits → saturation

The provider reads `deploy.resources.limits` (falling back to
`reservations`) and reports them with every metric sample:

- `cpuLimit` — cores allocated (× replica count on that node)
- `memLimitMb` — memory limit (× replica count); without a limit the cgroup
  limit is used, which is the **host** memory — saturation then looks tiny.

Set limits on the services you care about: that is what turns the ring, the
glow and the bars from "relative to the neighbours" into "vs what it may use".

City capacity (the `63 % CPU · 71 % mem · 84 % disk` gauge next to the city
name) comes from the Swarm node itself (`docker node inspect` → `Resources`),
so it is always available.

### Disk

Disk is **city-level only** — a filesystem belongs to the box, not to the
containers scheduled on it, so there is no service-sum equivalent and no
`Disk` view mode: buildings are never coloured by disk. The per-node agent
reads it from the host, and shows it in two places:

- the **city badge** and the **Cities panel**: used ÷ total of the host root
  filesystem, as a percentage, toned like the CPU and memory badges;
- the **Cities panel**, one line below: the machine's aggregated block
  throughput, `I/O ↓ 12.4 MB/s ↑ 4.1 MB/s`. Whole disks only (`sda`, not
  `sda1`), since partitions sum to their parent and would be counted twice.

## Reading the city

| Visual | Meaning |
|--------|---------|
| **Building colour** (Health mode) | Type colour when healthy; orange = degraded, red = down, grey = unknown. |
| **Building height** | Memory footprint, log-scaled relative to the biggest consumer of the same city (0.7× … 1.7×). Without memory data: request rate. |
| **Glow / bloom** | CPU saturation vs allocated cores. A building that "burns" is at or above its limit. Red pulse = error rate > 1 %. |
| **Ground ring** | Memory vs limit, as an arc: green → orange → red, full circle = 100 %. Only drawn when a limit is known. |
| **Neighbourhood slab** | `confcity.group`; colour is stable per group name. |
| **Dashed links** | Dash speed ∝ egress throughput of the source (`netTxKbps`), red when the source has errors. Thin = inferred. Arcs = across nodes. |
| **Island look** | The biome: `confcity.biome` on the node, else deduced from the type mix. Ground / beach colours, coast raggedness and a slight tint of the buildings. Roads, kerbs and the liveness colours never change with it. |
| **Lighthouse** | One per island, on the seafront: colour = the **worst** of the machine's CPU / memory / disk, on the same green → red ramp; the beam sweeps faster as it worsens. Dark and still = nothing measured, blinking = `services` fallback (a floor, not the machine). |
| **Power station** | Utility district, next to the lighthouse: the stack smokes with the machine's **CPU** — a thin wisp when idle, a hot dense column when saturated, its colour on the green → red ramp. |
| **Water tower** | Same district: the tank fills with the machine's **memory**, empty at 0 %, brim-full at 100 %, the water coloured on the same ramp. |
| **Container quay** | Same district: boxes stack with the machine's **disk**, an empty quay for a fresh disk, a full one at 100 % plus a box put down askew past 95 %. |
| **Scaffolding** | An installation under construction has no machine measurement behind it — the `services` fallback for CPU and memory, no host mount at all for disk. A building site is shown rather than a gauge at rest, which would read as an idle machine. |
| **City gauge** | The **machine**, not the sum of its buildings: CPU, memory and disk of the host ÷ node capacity. Falls back to the sum of the visible services, then tagged `services` — a floor, not the machine's load. Disk has no such fallback (see below). |

### View modes (status bar: `Health · CPU · Memory · Network`)

In a heatmap mode every building turns grey and glows with a single metric —
green (idle) → orange → red (saturated). Dark grey = no data for that metric.
The ground ring follows the same metric. The **Top 5** panel on the left
ranks the biggest consumers of the selected metric (bars are relative to the
top consumer of the same city); click a row to select the building.

### Detail drawer

Selecting a building shows **Resources** bars — `CPU 1.20 / 2.00 cores 60 %`,
`Memory 480 MB / 512 MB 94 %`, network in/out — followed by the metric
sparklines and the links declared for the node.

## Multi-node caveat

Container stats are read from the local Docker socket, so the provider only
sees metrics for containers on the node it runs on. Run one provider per node
(`deploy.mode: global`) with distinct `PROVIDER_ID`s, or accept metrics for
the manager only. Topology, labels, liveness and node capacity are cluster-wide
either way.

That per-node agent also measures the machine itself, which needs two read-only
bind-mounts (see `docker-compose.swarm.yml`):

| Mount | Env | Gives |
|-------|-----|-------|
| `/proc:/host/proc:ro` | `HOST_PROC=/host/proc` | host CPU, memory, load average, disk **I/O** (`/proc/diskstats`) |
| `/:/hostfs:ro` | `HOST_FS=/hostfs` | disk **space** — the container's own `/` is the overlay, which reports whatever backs `/var/lib/docker`, not the machine |

Each degrades on its own: without a mount the agent logs one warning and simply
omits those fields — container-level metrics, topology and the rest are
unaffected, and the corresponding badge disappears rather than showing a wrong
number.

---

## Type inference from image names

When `confcity.type` is absent, the provider guesses from the Docker image:

| Pattern in image name | Inferred type |
|---|---|
| `postgres`, `mysql`, `mariadb`, `mongo`, `clickhouse`, `cockroach`, `cassandra`, `couchdb`, `influx`, `timescale` | `db` |
| `redis`, `memcache`, `varnish`, `hazelcast` | `cache` |
| `rabbit`, `kafka`, `nats`, `pulsar`, `activemq`, `celery`, `bull` | `queue` |
| anything else | `app` |

## Validation rules

- `confcity.type` must be one of: `app`, `db`, `cache`, `queue`. Anything else is
  ignored and the type falls back to image inference.
- `confcity.biome` must be one of: `harbour`, `meadow`, `dunes`, `tundra`, `basalt`.
  Unknown values are ignored.
- `confcity.links` values must be existing Swarm service names. Unknown names are logged
  and ignored — they do not cause errors, but the link is not drawn.
- `confcity.hidden`, `confcity.ambient` and `confcity.ingress` accept `true`, `1`, or `yes`
  (case-insensitive).
  Anything else (including the absence of the label) means false.
- All label values are strings in YAML — quote booleans and numbers:
  `confcity.hidden: "true"`, not `confcity.hidden: true` (YAML would parse the latter
  as a boolean, which Docker serialises to `"True"` — it still works, but quoting is
  safer).

## Decision checklist (for an LLM labelling a stack)

When asked to add Conf City labels to a Swarm stack, follow this order:

1. **Identify each service's role** → set `confcity.type` when the image name is not
   enough to guess correctly (e.g. a Go binary named `processor` that is really a queue
   consumer → `confcity.type: queue`).

2. **Group related services** → assign `confcity.group` values. Good groups: `web`,
   `data`, `jobs`, `auth`, `monitoring`, `infra`. Keep it short and consistent.

3. **Declare explicit links** → set `confcity.links` on services whose dependencies
   matter for the topology. Use the Swarm **service name** (not the image name).
   Separate multiple targets with commas, no spaces: `confcity.links: db,cache,events`.

4. **Hide noise** → `confcity.hidden: "true"` on exporters, agents, log shippers,
   sidecars — anything that is infrastructure plumbing, not a business service.

5. **Mark ambient services** → `confcity.ambient: "true"` on services that every other
   service talks to (auth servers, service meshes, log collectors) — their star of
   incoming roads hides the real topology.

6. **Mark the front doors** → `confcity.ingress: "true"` on the reverse proxies and API
   gateways that traffic from outside actually enters through. Each becomes a port on the
   coast; leave the internal services alone, or the island is all quay and no city.

7. **Set nice labels** → `confcity.label` for human-readable names, `confcity.description`
   for context shown in the detail drawer.

8. **Set resource limits** → `deploy.resources.limits` on at least the services the user
   wants to monitor for saturation.

9. **Optionally pin biomes** → `docker node update --label-add confcity.biome=<biome>`
   on nodes where the auto-deduction doesn't match the user's preference.

## Common patterns

### Microservices with a shared database
```yaml
labels:
  confcity.type: app
  confcity.group: web
  confcity.links: postgres,redis
```

### Stateful service (database, cache)
```yaml
labels:
  confcity.type: db       # or cache / queue
  confcity.group: data
  # Usually no outgoing links — it is the target
```

### Background worker
```yaml
labels:
  confcity.type: app      # or queue if it *is* the queue
  confcity.group: jobs
  confcity.links: db,rabbitmq
```

### Infrastructure to hide
```yaml
labels:
  confcity.hidden: "true"
```

### Internet entry point (becomes the port)
```yaml
labels:
  confcity.type: app
  confcity.label: Traefik
  confcity.ingress: "true"
```

### Ambient service (everyone uses it)
```yaml
labels:
  confcity.type: app
  confcity.label: Keycloak
  confcity.ambient: "true"
  confcity.links: db      # its own outgoing links are still drawn
```
