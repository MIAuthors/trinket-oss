
## Running a server from the image instead (recommended)

`docker-compose.prod.yml` removes every host mount from the app service, so the
image is the only source of code and dependencies:

    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

Updating then has no dependency step at all — rebuild and restart, and nothing
can be stale. `config/` remains a read-only host mount, because deploy secrets
(the session cookie password, bucket credentials) live in gitignored
`config/local.yaml` / `config/local-production.yaml` and must not be baked into
an image. Without them the app exits at boot with "Session cookie password not
configured". It also sets `NODE_ENV=production`, which a compose deploy
otherwise lacks (issue #111), and adds a healthcheck so a crash-looping app
shows as unhealthy rather than merely "Up".

### Migrating an existing server

⚠️ Use the **same compose project name** you already use — `docker compose ls`
shows it. Data volumes are matched by project-qualified name, so a different
name would create empty ones and the database would appear to have vanished.

    cd <deploy dir>
    git pull
    # If the box has its own docker-compose.override.yml (proxy network, LTI
    # vars), include it explicitly — passing -f disables compose's automatic
    # loading of it, and omitting it will silently drop those settings.
    COMMIT_ID=$(git rev-parse HEAD) \
      GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
      BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
      docker compose -f docker-compose.yml -f docker-compose.prod.yml build app
    docker compose down                    # containers only; volumes are untouched
    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
    docker volume ls | grep -E 'mongodb_data|garage_data'   # confirm reuse, not recreation

The now-unused `<project>_node_modules`, `<project>_public_components` and
`<project>_public_css` volumes can be removed once the stack is healthy.

### Why the build arguments matter

With no bind mount the image has no `.git`, so `/version` cannot fall back to
reading the checkout. An unstamped image reports whatever `build-info.json` was
committed, which can name a commit the server is not running. Passing
`COMMIT_ID`, `GIT_BRANCH` and `BUILD_TIME` at build time makes `/version`
authoritative — it reports `commitSource: env` when they are present.
