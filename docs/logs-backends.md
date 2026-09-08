# Log backends

Conf City reads logs through a `LogSource` — an interface with one method, `fetch(query)`.
The Swarm provider picks one at startup from `LOGS_BACKEND` and uses it for both the live
tail and historical backfill. Exactly one backend is ever active: two sources reading the
same containers push every line twice, under timestamps too close together to reconcile.

| `LOGS_BACKEND` | history | attribution per node | source |
|---|---|---|---|
| `docker` *(default)* | no | no — one arbitrary city | `/services/{id}/logs` on the manager |
| `victorialogs` | yes | yes | `POST /select/logsql/query` |

Anything else falls back to `docker` with a warning.

## Why a store beats the Docker API

`/services/{id}/logs` aggregates every replica of a service and does not say which node
emitted a line, so `docker-swarm.ts` attributes them all to whichever city it happens to see
first. It also only serves a tail: there is no way to ask for a past window, which is why the
panel used to stay empty until the next push, and why anything arriving with the panel closed
was lost. Finally, the provider samples 5 services per tick to bound the fan-out, so lines are
dropped by design.

A log store fixes all three: the Swarm labels travel with each line (so the emitting node is
known), a range query is one HTTP call for every service at once, and nothing is sampled away.

## VictoriaLogs

### Expected fields

The adapter assumes a collector that forwards container labels verbatim — Vector's
`docker_logs` source does, and so does anything writing the standard Docker label set:

| field | used for |
|---|---|
| `_time` | entry timestamp (RFC3339, nanoseconds; truncated to ms) |
| `_msg` | message, and the level is parsed from it |
| `label.com.docker.swarm.service.id` | matches `TopologyEntry.serviceId` |
| `label.com.docker.swarm.node.id` | matches the Swarm node id → the city |

Two things that look useful but are not:

- **`host` is not the Swarm node hostname.** It is the hostname of the *collector* container
  (one per node). It does discriminate nodes, but it is not a city id — that comes from
  `label.com.docker.swarm.node.id`, resolved through the topology the provider already holds.
- **`stream=stderr` is not an error signal.** Plenty of services log at INFO on stderr. The
  level is parsed from the message text, by `logsources/level.ts`.

### Generated query

One request covers every target, so the cost per tick is a single round-trip regardless of
how many services the cluster runs:

```logsql
"label.com.docker.swarm.service.id":in("<id>","<id>", …)
| sort by (_time desc)
| limit <limit>
| fields _time, _msg, "label.com.docker.swarm.service.id", "label.com.docker.swarm.node.id"
```

with `start` / `end` passed as form parameters. Two details that matter:

- `end` is **exclusive**, which is exactly the half-open window the caller asks for: adjacent
  polls neither drop nor duplicate a line on the boundary.
- **The sort is not cosmetic.** `limit` without it returns an arbitrary subset of the window
  rather than the newest lines. Results then come back newest-first and are re-sorted
  ascending by the adapter, because everything downstream expects oldest-first.

These labels are ordinary fields, not stream fields, so filtering on them costs a scan. If a
24h backfill over many services ever gets slow, the fix is on the ingestion side — add
`label.com.docker.swarm.service.id` to the collector's stream fields — not in this code.

### Environment

| variable | default | meaning |
|---|---|---|
| `LOGS_BACKEND` | `docker` | `docker` or `victorialogs` |
| `VICTORIALOGS_URL` | `http://victorialogs:9428` | base URL |
| `VICTORIALOGS_TENANT` | *(none)* | `accountID:projectID`, sent as `AccountID` / `ProjectID` headers |
| `VICTORIALOGS_TIMEOUT_MS` | `10000` | hard deadline per request |
| `VICTORIALOGS_EXTRA_FILTER` | *(none)* | extra LogsQL filter, ANDed in (e.g. `stream:stdout`) |
| `LOGS_LIVE_LIMIT` | `200` | entries per live tick |
| `SWARM_LOGS_INTERVAL` | `3000` | live poll period, ms |

### Deployment

`docker-compose.victorialogs.yml` sets the two variables and joins `provider-swarm` to the
network VictoriaLogs lives on (`VICTORIALOGS_NETWORK`, default `monitoring_obs`, where the
service is aliased `victorialogs`). Point `VICTORIALOGS_URL` / `VICTORIALOGS_NETWORK` in `.env`
at your own store. `just deploy` includes the overlay; dropping
`-f docker-compose.victorialogs.yml` from the chain reverts to Docker-API logs.

## Hidden nodes are never queried

Services labelled `confcity.hidden=true` are excluded from the target list. Beyond keeping
agents and exporters out of the panel, this is what stops `provider-swarm` from reading — and
re-emitting — its own output.

## Live tail and backfill overlap on purpose

A store ingests with a lag of a few seconds, so a cursor that only ever moves forward silently
drops whatever landed late. Each live poll re-reads the last 2s, and duplicates are dropped by
content (`proxy/logKey.ts`: `timestamp|node|message` — neither Docker nor VictoriaLogs hands
out a per-entry id). Backfill answers are merged the same way, in the proxy and again in the
browser, so a range query overlapping the live tail produces no doubles.

## Backfill wiring

Historical queries travel a route that did not exist before: **proxy → provider**.

```
frontend  --query:logs-->            proxy   --query:logs-->            provider
frontend  <--logs-result--           proxy   <--provider:logs-result--  provider
```

- A provider advertises `logs-query` in its `capabilities` only when its source
  `supportsHistory`. The proxy fans a query out to those providers only.
- If none can answer, the proxy replies from its own ring buffer with `fromCache: true` — a
  few hundred recent lines, enough to fill the panel, not real history.
- Every provider **must** answer, even to report an error, or the query waits out the proxy's
  12s timeout. `BaseProvider` guarantees this.
- Timeouts cascade, and the order is load-bearing: adapter 10s < proxy 12s < frontend 15s.
  Invert any pair and the outer layer gives up just before the inner one answers.

## Adding another backend

Implement `LogSource` in `proxy/providers/logsources/`, register it in the `makeLogSource`
switch, and set `supportsHistory` honestly — it is what gates the `logs-query` capability.
Loki would be one such file; note that VictoriaLogs' Loki compatibility is **ingestion only**
(`/insert/loki/api/v1/push`), so it cannot be reached through a Loki adapter.
