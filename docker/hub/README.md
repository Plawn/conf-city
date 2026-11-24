# Conf City

3D infrastructure visualization: each Swarm node is a **city** on its own island, each
service a **building**, links become roads and bridges with traffic driven by real throughput.

Source, docs and issues: https://github.com/Plawn/conf-city · MIT license.

## Images

| Image | Role |
|---|---|
| `conf-city-frontend` | nginx serving the UI; proxies `/ws/`, `/api/`, `/health` to the proxy |
| `conf-city-proxy` | WebSocket hub between providers and browsers (port 4001) |
| `conf-city-provider-swarm` | topology, liveness, logs, limits — run on a manager |
| `conf-city-provider-node` | container usage + machine CPU/memory/disk — run on every node |
| `conf-city-provider-dummy` | generated demo data |

All images are `linux/amd64` and `linux/arm64`. Tags: `X.Y.Z`, `X.Y`, `latest`.

## Quick start

Demo, any Docker host — [`docker-compose.demo.yml`](https://github.com/Plawn/conf-city/blob/main/docker-compose.demo.yml):

```sh
docker compose -f docker-compose.demo.yml up    # http://localhost:8080
```

Your Swarm — [`docker-compose.release.yml`](https://github.com/Plawn/conf-city/blob/main/docker-compose.release.yml):

```sh
docker stack deploy -c docker-compose.release.yml confcity   # http://<node>:8080
```

**No built-in authentication**: put the UI behind your own reverse proxy / auth, and keep
port 4001 off the public network.

## Configuration

| Variable | Image | Default | Purpose |
|---|---|---|---|
| `PROXY_UPSTREAM` | frontend | `proxy:4001` | host:port of the proxy service |
| `PROXY_PORT` | proxy | `4001` | listen port |
| `LOGS_BACKEND` | provider-swarm | `docker` | `victorialogs` to read logs from VictoriaLogs (`VICTORIALOGS_URL`) |
| `PROXY_URL` | providers | `ws://proxy:4001/ws/provider` | where providers report |
| `DOCKER_HOST` | provider-swarm/node | `/var/run/docker.sock` | Docker API (mount the socket read-only) |
| `AMBIENT_SERVICES` | provider-swarm | — | services whose incoming links are not drawn |
| `PROVIDER_ID` | provider-node | — | **must be distinct per node**: `node-agent-{{.Node.Hostname}}` |
| `HOST_PROC` | provider-node | — | host procfs mount (`/proc:/host/proc:ro`) for machine CPU/memory/disk I/O |
| `HOST_FS` | provider-node | — | host root mount (`/:/hostfs:ro`) for disk space |

Services are described with `confcity.*` labels (type, label, group, links…):
[swarm labels](https://github.com/Plawn/conf-city/blob/main/docs/swarm-labels.md).
