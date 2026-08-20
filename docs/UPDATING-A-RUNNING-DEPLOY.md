# Updating a running deploy (and why a rebuild is not always enough)

Applies to any deployment driven by `docker-compose.yml` — local development,
the shared trials, and the self-hosted production server. Cloud Run deploys are
image-only and are not affected.

## The one surprise worth knowing

`docker-compose.yml` bind-mounts the working copy over the container's app
directory and then keeps three paths in **named volumes** so the host copies do
not shadow what the image built:

```yaml
volumes:
  - .:/usr/local/node/trinket
  - node_modules:/usr/local/node/trinket/node_modules
  - public_components:/usr/local/node/trinket/public/components
  - public_css:/usr/local/node/trinket/public/css
```

Two consequences follow, and they pull in opposite directions:

* **Code updates are instant.** The container runs your checkout, so
  `git pull` plus a restart is enough. No rebuild.
* **Dependency updates are not applied at all.** A named volume is created once
  and then persists. `docker compose up --build` rebuilds the image but leaves
  the volume untouched, so a branch that adds a package runs against the old
  set. The app then exits with `Cannot find module '<name>'` and PM2 restarts it
  in a loop — while the build output looks completely successful.

Since 2026-08 the startup check reports this directly: it lists the packages
`package.json` declares that are not present in `node_modules`, together with
the command to fix them. If you see that banner, nothing is broken — the
modules are simply a release behind.

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
on deploys where the container user differs from the host owner (the trial runs
as uid 999 against files owned by uid 1001) that fails with `EACCES`, and the
lockfile is the repository's business anyway.

## When you want certainty rather than speed

Rebuild the image and let the volumes fill from it again:

```bash
docker compose build app
docker compose down
docker volume rm <project>_node_modules <project>_public_components
docker compose up -d
```

Substitute the compose project name — `docker compose ls` will show it. An
empty named volume is populated from the image on first mount, so this
guarantees the running modules match the image exactly.

## Production

Production should always run the dependency set that was built from the
repository's `package.json`, with no host filesystem in the picture. On Cloud
Run that is already true: there is no bind mount and the image is the only
source. A compose-hosted production reaches the same place by dropping the
source bind mount and the three volume shadows so the image is authoritative,
which also removes any need for the steps above.
