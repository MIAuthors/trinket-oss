# Updating a running deploy (and why a rebuild is not always enough)

Applies to any deployment driven by `docker-compose.yml` — local development,
the shared trials, and self-hosted production. Cloud Run deploys are image-only
and unaffected.

## The one surprise worth knowing

`docker-compose.yml` bind-mounts the working copy over the container's app
directory and keeps three paths in **named volumes** so the host copies do not
shadow what the image built:

```yaml
volumes:
  - .:/usr/local/node/trinket
  - node_modules:/usr/local/node/trinket/node_modules
  - public_components:/usr/local/node/trinket/public/components
  - public_css:/usr/local/node/trinket/public/css
```

Two consequences follow, and they pull in opposite directions:

* **Code updates are instant.** The container runs your checkout, so `git pull`
  plus a restart is enough. No rebuild.
* **Dependency updates are not applied at all.** A named volume is created once
  and then persists. `docker compose up --build` rebuilds the image but leaves
  the volume untouched, so a branch that adds a package runs against the old
  set. The app exits with `Cannot find module '<name>'` and restarts in a loop —
  while the build output looks completely successful.

The startup check reports this directly: it lists the packages `package.json`
declares that are missing from `node_modules`, with the command that fixes them.
If you see that banner, nothing is broken — the modules are a release behind.

## Everyday: pulling a branch that changed only code

```bash
git fetch origin && git checkout <branch> && git pull
docker compose restart app
```

## After pulling anything that touched package.json or package-lock.json

```bash
docker compose exec -T app npm ci --no-audit --no-fund
docker compose restart app
```

Use `npm ci`, not `npm install`. `ci` installs exactly what the lockfile
specifies and writes only into `node_modules`. `npm install` also wants to
rewrite `package-lock.json`, which lives on the bind-mounted host filesystem —
where the container user differs from the host owner (the trial runs as uid 999
against files owned by uid 1001) that fails with `EACCES`, and the lockfile is
the repository's business anyway.

## When you want certainty rather than speed

```bash
docker compose build app
docker compose down
docker volume rm <project>_node_modules <project>_public_components
docker compose up -d
```

`docker compose ls` shows the project name. An empty named volume is populated
from the image on first mount, so this guarantees the running modules match the
image exactly.

## Running a server from the image instead (recommended)

`docker-compose.prod.yml` removes the host mounts from the app service, so the
image is the only source of code and dependencies:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# (needs Docker Compose >= 2.24.4 — the overlay uses the `!override` tag)
```

Updating then has no dependency step at all — rebuild and restart, and nothing
can be stale. `config/` remains a read-only host mount, because deploy secrets
(the session cookie password, bucket credentials) live in gitignored
`config/local.yaml` / `config/local-production.yaml` and must not be baked into
an image. Without them the app exits at boot with "Session cookie password not
configured". The overlay also sets `NODE_ENV=production`, which a compose deploy
otherwise lacks (issue #111), and adds a healthcheck so a crash-looping app
shows as unhealthy rather than merely "Up".

### Migrating an existing server

⚠️ Use the **same compose project name** you already use — `docker compose ls`
shows it. Data volumes are matched by project-qualified name, so a different
name would create empty ones and the database would appear to have vanished.

⚠️ If the box has its own `docker-compose.override.yml` (proxy network, LTI
vars), pass it explicitly. Supplying any `-f` disables compose's automatic
loading of it, and omitting it silently drops those settings.

```bash
cd <deploy dir>
git pull
COMMIT_ID=$(git rev-parse HEAD) \
  GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
  BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml build app
docker compose down                     # containers only; volumes are untouched
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.prod.yml up -d
docker volume ls | grep -E 'mongodb_data|garage_data'   # confirm reuse, not recreation
```

The now-unused `<project>_node_modules`, `<project>_public_components` and
`<project>_public_css` volumes can be removed once the stack is healthy.

### Why the build arguments matter

With no bind mount the image has no `.git`, so `/version` cannot fall back to
reading the checkout. An unstamped image reports whatever `build-info.json` was
committed, which can name a commit the server is not running. Passing
`COMMIT_ID`, `GIT_BRANCH` and `BUILD_TIME` at build time makes `/version`
authoritative — it reports `commitSource: env` when they are present.

## Which mode is this server in?

Ask the container, not the checkout — a bind-mounted deploy and an image-only
one look identical from the command line:

```sh
docker inspect trinket --format '{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}'
```

* Only `config` mounted → **image-only**. `git pull` alone changes nothing;
  the code lives in the image and you must rebuild.
* The whole checkout mounted at `/usr/local/node/trinket` → bind-mounted.
  `git pull` plus a restart is enough for code, and the dependency caveat above
  applies.

Getting this wrong is quiet rather than loud: on an image-only server a pull
and restart completes successfully and serves the *old* code, and `/version`
keeps reporting the build stamp, which looks correct.

## Before rebuilding: did dependencies actually change?

```sh
git diff --name-only <old-sha> <new-sha> | grep -E 'package(-lock)?\.json'
```

Empty output means no `npm ci` step is needed. On an image-only server the
rebuild handles dependencies anyway; this check matters on bind-mounted
deploys, where it is the difference between a restart and a crash loop.

## Checking it worked

Run the deploy smoke — the fastest honest answer, and safe against a live server
(anonymous, read-only):

```bash
cd test/browser
EXPECT_COMMIT=$(git rev-parse --short HEAD) \
TRINKET_BASE_URL=https://<your-host> \
  npx playwright test -c playwright.deploy.config.js
```

Or by hand:

```bash
docker exec trinket sh -lc "curl -sS http://localhost:3000/version"
docker logs --tail 20 trinket
```

`/version` should report the commit you just checked out. On a bind-mounted
deploy `commit` reflects the checkout while `buildCommit` reflects the image, so
those two differing is normal there and not a fault.
