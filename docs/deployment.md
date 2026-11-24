# Deployment

## Published images (Docker Hub)

Six images, `linux/amd64` + `linux/arm64`, tagged `X.Y.Z`, `X.Y` and `latest`:
`<ns>/conf-city-{frontend,proxy,provider-swarm,provider-node,provider-victoria,provider-dummy}`.

```sh
docker compose -f docker-compose.demo.yml up                 # demo data, any host → :8080
docker stack deploy -c docker-compose.release.yml confcity   # real Swarm → :8080
```

Neither file needs a checkout beyond itself, nor Traefik. There is no built-in auth: put a
reverse proxy that handles it in front. The Docker Hub page is `docker/hub/README.md`.

### Cutting a release

```sh
git push origin main           # ci.yml: typecheck, lint, tests, image builds (no push)
just release minor             # refuses unless ci is green on HEAD; bumps, commits, tags vX.Y.Z
git push origin main --tags    # the tag push is what publishes
```

Every push to `main` and every PR runs `.github/workflows/ci.yml`, so breakage shows up
before a version number is spent. `.github/workflows/release.yml` reruns those checks, checks the tag matches
`package.json`, builds the five images multi-arch, pushes them and syncs the Docker Hub
description. A `-rc.N` tag publishes `X.Y.Z-rc.N` only, never `latest`. Repo settings:
secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (Read/Write/Delete scope), optional variable
`DOCKERHUB_NAMESPACE` when it differs from the user. Bun and nginx base images are pinned in
the Dockerfiles and installs use `--frozen-lockfile`: bump them on purpose.

`.dockerignore` keeps `public/scenarios/wrapped/` (private infra) out of every build context.

## Local, plain compose

```sh
# Dummy data
docker compose -f docker-compose.yml -f docker-compose.dummy.yml up --build

# Real Swarm metrics
docker compose -f docker-compose.yml -f docker-compose.swarm.yml -f docker-compose.node-agent.yml up --build
```

Images: `docker/Dockerfile.frontend` (Vite build → nginx, `nginx.conf.template` serves the SPA
and proxies `/ws/`, `/api/` and `/health` to `$PROXY_UPSTREAM`, default `proxy:4001`), `docker/Dockerfile.proxy` (Bun), `docker/Dockerfile.provider` (Bun, dummy or
swarm providers).

## Site configuration (`.env`)

Everything site-specific — registry, public host, Traefik entrypoint and cert resolver,
Swarm placement, log store — lives in `.env`, which is not committed. Copy `.env.example`
to `.env` and edit it:

```sh
cp .env.example .env
```

The `justfile` loads it (`set dotenv-load`) so both `docker compose` and `docker stack deploy`
see the variables; the compose files default to the published Docker Hub images.

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_PREFIX` | `plawn/conf-city-` *(Docker Hub)* | prefix every image name is appended to, separator included; change it only to run your own builds from another registry |
| `TAG` | `latest` | image tag deployed (`just deploy` sets it to the checkout's version) |
| `CONFCITY_HOST` | `city.localhost` | host the frontend is served on (Traefik router rule) |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Traefik entrypoint |
| `TRAEFIK_CERTRESOLVER` | `resolver` | Traefik certificate resolver |
| `TRAEFIK_NETWORK` | `traefik` | name of the external Traefik network to join |
| `DEPLOY_CONSTRAINT` | `node.role == manager` | Swarm placement constraint for frontend and proxy |
| `VICTORIALOGS_URL` | `http://victorialogs:9428` | VictoriaLogs base URL (logs overlay) |
| `VICTORIALOGS_NETWORK` | `monitoring_obs` | external network VictoriaLogs (and VictoriaMetrics) live on |
| `VICTORIALOGS_SCHEMA` | `vector` | log field layout, `promtail` for `swarm_service` / `swarm_instance` |
| `VICTORIAMETRICS_URL` | `http://victoriametrics:8428` | VictoriaMetrics base URL (metrics overlay) |
| `AMBIENT_SERVICES` | *(empty)* | services whose incoming links are not drawn |

## Production (`justfile`)

Nothing is built on the cluster: it runs the images CI published to Docker Hub, which every
node pulls on its own. A change reaches production as a release.

```sh
just release patch && git push origin main --tags   # CI publishes X.Y.Z
just deploy                    # stack deploy of the checkout's version (package.json)
just deploy 0.2.0-rc.3         # or any published tag — also how you roll back
just status                    # services + tasks
just logs proxy                # tail one service
```

`deploy` passes `--resolve-image always`, so every node pins the same digest for the tag.
To test unreleased code on the cluster, cut a release candidate (`just release 0.3.0-rc.1`):
it never moves `latest`.

The overlay chain lives in the `justfile` (`files` / `stackfiles`). Drop
`docker-compose.victorialogs.yml` from it to read logs from the Docker API again
(see `logs-backends.md`).

## Usage source: VictoriaMetrics or the agent

The chain deploys `docker-compose.victoria.yml` (one `provider-victoria` replica reading
VictoriaMetrics, see `providers.md`). Without VictoriaMetrics, swap it for
`docker-compose.node-agent.yml` in the `justfile`. Switching does not remove the old service —
`docker stack deploy` never prunes — so drop it by hand: `docker service rm confcity_provider-node`
(or `confcity_provider-victoria`). Running both makes every usage value flap.

Moving an existing stack from the agent to VictoriaMetrics:

1. In `.env`, point at the monitoring services. From another stack, a service resolves by its
   **full** Swarm name (`<stack>_<service>`), not its short alias:
   `VICTORIAMETRICS_URL=http://<stack>_vmetrics:8428`, same for `VICTORIALOGS_URL`.
2. Check both are attached to `VICTORIALOGS_NETWORK` (`docker service inspect <svc>`).
3. With promtail shipping the logs, set `VICTORIALOGS_SCHEMA=promtail`.
4. Release (the image must exist on Docker Hub), `just deploy`, then
   `docker service rm confcity_provider-node`.
5. `just logs provider-victoria`: one `query failed` warning per field that cannot be read.

## Swarm agent mounts

The per-node agent (`docker-node.ts`, `mode: global`) needs a distinct `PROVIDER_ID`
(`node-agent-{{.Node.Hostname}}`) — the proxy indexes providers by id and homonyms evict each other.

To measure the machine it needs the host procfs (`/proc:/host/proc:ro`, `HOST_PROC=/host/proc`):
CPU, memory, load and disk **I/O** (`/proc/diskstats`, whole disks only). Disk **space** needs the
host root too (`/:/hostfs:ro`, `HOST_FS=/hostfs`): the container's own `/` is the overlay. Each
mount degrades on its own — one warning, then that figure is simply absent.
