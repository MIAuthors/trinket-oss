
## Running a server from the image instead (recommended)

`docker-compose.prod.yml` removes every host mount from the app service, so the
image is the only source of code and dependencies:

    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

Updating then has no dependency step at all — rebuild and restart, and nothing
can be stale. It also sets `NODE_ENV=production`, which a compose deploy
otherwise lacks (issue #111), and adds a healthcheck so a crash-looping app
shows as unhealthy rather than merely "Up".

### Migrating an existing server

⚠️ Use the **same compose project name** you already use — `docker compose ls`
shows it. Data volumes are matched by project-qualified name, so a different
name would create empty ones and the database would appear to have vanished.

    cd <deploy dir>
    git pull
    docker compose -f docker-compose.yml -f docker-compose.prod.yml build app
    docker compose down                    # containers only; volumes are untouched
    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
    docker volume ls | grep -E 'mongodb_data|garage_data'   # confirm reuse, not recreation

The now-unused `<project>_node_modules`, `<project>_public_components` and
`<project>_public_css` volumes can be removed once the stack is healthy.
