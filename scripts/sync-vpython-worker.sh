#!/usr/bin/env bash
# Copy the vpython-jupyter browser front-end + pure wheel into trinket's served
# components. Source of truth is the vpython-jupyter checkout — edit THERE.
set -euo pipefail
SRC="${VPJ:-$HOME/Development/glow-repos/vpython-jupyter}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/components/vpython-worker"
PYODIDE_JS="$ROOT/public/js/embed/pyodide.js"
mkdir -p "$DEST"

# The page fetches ONE hard-coded filename. Read it here rather than trusting
# whatever lands in DEST: a version bump that only happens on one side of that
# pair produces a 404 at run time, which surfaces to a student as "This is a
# site problem" with nothing pointing at the cause.
WHEEL_NAME=$(sed -n "s/^var VPYTHON_WHEEL_NAME = '\(.*\)';.*/\1/p" "$PYODIDE_JS")
if [ -z "$WHEEL_NAME" ]; then
  echo "FAILED: could not read VPYTHON_WHEEL_NAME from $PYODIDE_JS" >&2
  exit 1
fi

# One wheel, not "the alphabetically last of however many are lying around".
WHEELS=$(ls "$SRC"/dist/vpython-*-py3-none-any.whl 2>/dev/null || true)
WHEEL_COUNT=$(printf '%s' "$WHEELS" | grep -c . || true)
if [ "$WHEEL_COUNT" -eq 0 ]; then
  echo "No pure wheel in $SRC/dist — build one:" >&2
  echo "  cd $SRC && VPYTHON_PURE_PYTHON=1 SETUPTOOLS_SCM_PRETEND_VERSION=7.6.5 python3 -m build --wheel" >&2
  exit 1
fi
if [ "$WHEEL_COUNT" -gt 1 ]; then
  echo "FAILED: $SRC/dist holds $WHEEL_COUNT wheels; which one is the build you just made?" >&2
  printf '  %s\n' "$WHEELS" >&2
  echo "Delete the stale ones (rm $SRC/dist/vpython-*.whl) and rebuild." >&2
  exit 1
fi
WHEEL="$WHEELS"
WHEEL_BASE="$(basename "$WHEEL")"

if [ "$WHEEL_BASE" != "$WHEEL_NAME" ]; then
  echo "FAILED: the built wheel and the page disagree about the filename." >&2
  echo "  built:            $WHEEL_BASE" >&2
  echo "  pyodide.js wants: $WHEEL_NAME" >&2
  echo "Shipping this would 404 at run time. Update VPYTHON_WHEEL_NAME in" >&2
  echo "$PYODIDE_JS (and GLOWCOMM_HOST_VERSION in glowcomm_host.js), or rebuild" >&2
  echo "the wheel at the expected version." >&2
  exit 1
fi

# The front-end and the wheel are two halves of one protocol, built from the
# same checkout and copied by hand. Carrying the version in both is the only
# thing that makes a half-done sync visible instead of mysterious.
HOST_JS="$SRC/vpython/vpython_libraries/glowcomm_host.js"
HOST_VERSION=$(sed -n "s/^var GLOWCOMM_HOST_VERSION = '\(.*\)';.*/\1/p" "$HOST_JS")
WHEEL_VERSION=$(printf '%s' "$WHEEL_BASE" | sed -n 's/^vpython-\(.*\)-py3-none-any\.whl$/\1/p')
if [ "$HOST_VERSION" != "$WHEEL_VERSION" ]; then
  echo "FAILED: front-end version '$HOST_VERSION' != wheel version '$WHEEL_VERSION'." >&2
  echo "Set GLOWCOMM_HOST_VERSION in $HOST_JS to match the wheel." >&2
  exit 1
fi

# Stale wheels here are worse than useless: nothing fetches them, they are 3.5 MB
# each, and they get committed. Only ever one.
rm -f "$DEST"/vpython-*.whl
cp "$HOST_JS" "$DEST/"
cp "$WHEEL" "$DEST/"
echo "synced: $(ls "$DEST")  (vpython-jupyter $WHEEL_VERSION)"

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
  docker exec "$CONTAINER" sh -c "rm -f $CDEST/vpython-*.whl"
  docker cp "$DEST/glowcomm_host.js" "$CONTAINER:$CDEST/"
  docker cp "$DEST/$WHEEL_BASE" "$CONTAINER:$CDEST/"
  echo "copied into $CONTAINER:$CDEST/ — glowcomm_host.js, $WHEEL_BASE"
fi
