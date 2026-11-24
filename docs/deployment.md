# Deployment

## Published images (Docker Hub)

Five images, `linux/amd64` + `linux/arm64`, tagged `X.Y.Z`, `X.Y` and `latest`:
`<ns>/conf-city-{frontend,proxy,provider-swarm,provider-node,provider-dummy}`.

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
docker compose -f docker-compose.yml -f docker-compose.swarm.yml up --build
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
see the variables; the compose files carry defaults that run on a single-node box with no
external registry.

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_PREFIX` | `confcity/` *(local images)* | prefix every image name is appended to, separator included: `registry.example.com/you/conf-city/` or `you/conf-city-` (Docker Hub allows only `namespace/repo`) |
| `TAG` | `latest` | image tag built, pushed and deployed |
| `CONFCITY_HOST` | `city.localhost` | host the frontend is served on (Traefik router rule) |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Traefik entrypoint |
| `TRAEFIK_CERTRESOLVER` | `resolver` | Traefik certificate resolver |
| `TRAEFIK_NETWORK` | `traefik` | name of the external Traefik network to join |
| `DEPLOY_CONSTRAINT` | `node.role == manager` | Swarm placement constraint for frontend and proxy |
| `VICTORIALOGS_URL` | `http://victorialogs:9428` | VictoriaLogs base URL (logs overlay) |
| `VICTORIALOGS_NETWORK` | `monitoring_obs` | external network VictoriaLogs lives on |
| `AMBIENT_SERVICES` | *(empty)* | services whose incoming links are not drawn |

## Production (`justfile`)

The `justfile` always pushes to `IMAGE_PREFIX`:

```sh
just deploy                    # build + push + stack deploy, everything
just redeploy provider-swarm   # same, one service (still ends on a full stack deploy)
just up                        # stack deploy without rebuilding
just status                    # services + tasks
just logs proxy                # tail one service
```

**The registry is not optional on a multi-node cluster.** An image built on the manager exists
nowhere else, so a task scheduled on another node is rejected with `pull access denied` and the
service silently stops running there. That is why every recipe pushes, and why `redeploy` ends
on `docker stack deploy` rather than `docker service update`: only stack deploy resolves `:latest`
to a digest and pins it, so all nodes run the same build. On a single-node box leave `IMAGE_PREFIX`
unset and pin the placement with `DEPLOY_CONSTRAINT=node.hostname == <that node>`.

The overlay chain lives in the `justfile` (`files` / `stackfiles`). Drop
`docker-compose.victorialogs.yml` from it to read logs from the Docker API again
(see `logs-backends.md`).

## Swarm agent mounts

The per-node agent (`docker-node.ts`, `mode: global`) needs a distinct `PROVIDER_ID`
(`node-agent-{{.Node.Hostname}}`) — the proxy indexes providers by id and homonyms evict each other.

To measure the machine it needs the host procfs (`/proc:/host/proc:ro`, `HOST_PROC=/host/proc`):
CPU, memory, load and disk **I/O** (`/proc/diskstats`, whole disks only). Disk **space** needs the
host root too (`/:/hostfs:ro`, `HOST_FS=/hostfs`): the container's own `/` is the overlay. Each
mount degrades on its own — one warning, then that figure is simply absent.
