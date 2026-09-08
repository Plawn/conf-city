# Site configuration (REGISTRY, CONFCITY_HOST, DEPLOY_CONSTRAINT…) comes from `.env`,
# which is not committed. Copy `.env.example` to `.env` and edit it before deploying.
set dotenv-load := true

# Drop `-f docker-compose.victorialogs.yml` to go back to reading logs from the Docker API.
files := "-f docker-compose.yml -f docker-compose.swarm.yml -f docker-compose.victorialogs.yml"
# `docker stack deploy` takes -c, not -f.
stackfiles := "-c docker-compose.yml -c docker-compose.swarm.yml -c docker-compose.victorialogs.yml"
stack := "confcity"

# `REGISTRY` is the registry every node pulls from. It is NOT optional on a multi-node
# cluster: an image built on the manager exists nowhere else, so a task scheduled on another
# node is rejected outright ("pull access denied"). Unset, it falls back to the local image
# name `confcity`, which only works on a single-node box.
compose := "docker compose " + files
stack-deploy := "docker stack deploy " + stackfiles + " " + stack

# Build, push and deploy everything
deploy:
  {{compose}} build
  {{compose}} push
  {{stack-deploy}}

# Build, push and deploy a single service (e.g. just redeploy frontend)
# It ends on a full `stack deploy`, not `service update`: only stack deploy resolves :latest
# to a digest and pins it, so every node runs the same build. It also touches nothing else —
# the other services' digests are unchanged, so Swarm leaves them alone.
redeploy service:
  {{compose}} build {{service}}
  {{compose}} push {{service}}
  {{stack-deploy}}

# Deploy stack without rebuilding
up:
  {{stack-deploy}}

# Show service status
status:
  docker stack services {{stack}}
  docker stack ps {{stack}} --no-trunc

# Tail logs for a service (e.g. just logs proxy)
logs service="proxy":
  docker service logs -f {{stack}}_{{service}}
