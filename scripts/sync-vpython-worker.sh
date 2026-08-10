#!/usr/bin/env bash
# Copy the vpython-jupyter browser front-end + pure wheel into trinket's served
# components. Source of truth is the vpython-jupyter checkout — edit THERE.
set -euo pipefail
SRC="${VPJ:-$HOME/Development/glow-repos/vpython-jupyter}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/components/vpython-worker"
mkdir -p "$DEST"
cp "$SRC/vpython/vpython_libraries/glowcomm_host.js" "$DEST/"
WHEEL=$(ls "$SRC"/dist/vpython-*-py3-none-any.whl 2>/dev/null | tail -1 || true)
if [ -z "$WHEEL" ]; then
  echo "No pure wheel in $SRC/dist — build one:"
  echo "  cd $SRC && VPYTHON_PURE_PYTHON=1 SETUPTOOLS_SCM_PRETEND_VERSION=7.6.5 python3 -m build --wheel"
  exit 1
fi
cp "$WHEEL" "$DEST/"
echo "synced: $(ls "$DEST")"

# docker-compose.yml mounts a NAMED VOLUME (public_components) over
# public/components, so the copies above are invisible to the running dev
# container — the volume masks the worktree. Push them into the volume too, or
# the browser tests fetch a 404. No docker, or no container: just say so.
CONTAINER="${TRINKET_CONTAINER:-trinket-gcr}"
CDEST=/usr/local/node/trinket/public/components/vpython-worker
if ! command -v docker >/dev/null 2>&1; then
  echo "note: docker not found — skipped the dev-container copy ($CONTAINER:$CDEST)"
elif [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
  echo "note: container '$CONTAINER' is not running — skipped the dev-container copy."
  echo "      Re-run this script once it is up, or the page will 404 on /components/vpython-worker/."
else
  docker exec "$CONTAINER" mkdir -p "$CDEST"
  docker cp "$DEST/glowcomm_host.js" "$CONTAINER:$CDEST/"
  docker cp "$DEST/$(basename "$WHEEL")" "$CONTAINER:$CDEST/"
  echo "copied into $CONTAINER:$CDEST/ — glowcomm_host.js, $(basename "$WHEEL")"
fi
