# Site configuration (CONFCITY_HOST, DEPLOY_CONSTRAINT…) comes from `.env`,
# which is not committed. Copy `.env.example` to `.env` and edit it before deploying.
set dotenv-load := true

# Drop `-f docker-compose.victorialogs.yml` to go back to reading logs from the Docker API.
# Swap docker-compose.victoria.yml for docker-compose.node-agent.yml without VictoriaMetrics.
files := "-f docker-compose.yml -f docker-compose.swarm.yml -f docker-compose.victorialogs.yml -f docker-compose.victoria.yml"
# `docker stack deploy` takes -c, not -f.
stackfiles := "-c docker-compose.yml -c docker-compose.swarm.yml -c docker-compose.victorialogs.yml -c docker-compose.victoria.yml" + auth
# Forward-auth in front of the UI, only when `.env` names the middlewares.
auth := if env_var_or_default("FORWARDAUTH_MIDDLEWARES", "") != "" { " -c docker-compose.forwardauth.yml" } else { "" }
stack := "confcity"

# Images are the ones CI publishes to Docker Hub (plawn/conf-city-*): nothing is built here.
# `version` is the checkout's package.json version, i.e. the release this tree was tagged as.
stack-deploy := "docker stack deploy --resolve-image always " + stackfiles + " " + stack
version := `sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json`

# Deploy a published release (default: the checkout's version), e.g. just deploy 0.2.0
deploy tag=version:
  TAG={{tag}} {{stack-deploy}}

# Show service status
status:
  docker stack services {{stack}}
  docker stack ps {{stack}} --no-trunc

# Tail logs for a service (e.g. just logs proxy)
logs service="proxy":
  docker service logs -f {{stack}}_{{service}}

# Pushing the tag is what publishes: CI builds and pushes the images on `v*` tags.
# Only tracked changes block it: untracked scratch files are fine. HEAD must be pushed and
# green on CI first, so a failing test never costs a version number.
# Cut a release (patch | minor | major | X.Y.Z): bumps package.json, commits, tags vX.Y.Z
release increment:
  git diff --quiet HEAD || (echo "uncommitted changes" && exit 1)
  bun scripts/ci-green.ts
  bun pm version {{increment}} --no-git-tag-version
  v=$(bun pm pkg get version | tr -d '"') && git commit -q -m "Release v$v" package.json && git tag -a "v$v" -m "v$v" && echo "tagged v$v — now: git push origin main --tags"
