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

# Everything above compares NAMES. None of it can see the failure that actually
# happens: editing the source, forgetting to rebuild, and syncing last week's
# wheel — the filename and the version are identical either way, so both gates
# pass and the browser runs code nobody wrote. Timestamps are the one thing that
# does differ. __pycache__ is pruned because merely running the test suite
# rewrites it.
STALE=$(find "$SRC/vpython" -name '__pycache__' -prune -o -type f -newer "$WHEEL" -print 2>/dev/null | head -5)
if [ -n "$STALE" ]; then
  echo "FAILED: $SRC source is NEWER than the wheel in dist/ — the wheel is stale." >&2
  printf '  %s\n' "$STALE" >&2
  echo "Nothing else here can catch this: the version did not change, so the" >&2
  echo "filename and version gates both pass on a wheel built before those edits." >&2
  echo "Rebuild it:" >&2
  echo "  cd $SRC && VPYTHON_PURE_PYTHON=1 SETUPTOOLS_SCM_PRETEND_VERSION=$WHEEL_VERSION python3 -m build --wheel" >&2
  exit 1
fi

# Stale wheels here are worse than useless: nothing fetches them, they are 3.5 MB
# each, and they get committed. Only ever one.
rm -f "$DEST"/vpython-*.whl
cp "$HOST_JS" "$DEST/"
cp "$WHEEL" "$DEST/"

# Provenance, committed alongside the binary: which vpython-jupyter commit built
# the wheel trinket is serving. The timestamp is deliberately NOT recorded — a
# re-sync of the same build must produce no diff, or the file becomes noise
# everyone learns to ignore.
SRC_SHA=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo 'unknown (not a git checkout)')
if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then
  SRC_SHA="$SRC_SHA + UNCOMMITTED CHANGES"
fi
if command -v shasum >/dev/null 2>&1; then
  WHEEL_SUM=$(shasum -a 256 "$WHEEL" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then
  WHEEL_SUM=$(sha256sum "$WHEEL" | cut -d' ' -f1)
else
  WHEEL_SUM=unknown
fi
{
  echo "# Written by scripts/sync-vpython-worker.sh. Do not edit."
  echo "#"
  echo "# 'source:' is the line that answers \"which code is this?\". 'sha256:'"
  echo "# identifies THIS ARTIFACT only: wheels are not byte-reproducible, so two"
  echo "# builds of the same commit have different sums. A changed sha256 with an"
  echo "# unchanged source: means someone rebuilt, not that the code moved."
  echo "wheel:   $WHEEL_BASE"
  echo "source:  vpython-jupyter $SRC_SHA"
  echo "sha256:  $WHEEL_SUM"
} > "$DEST/BUILD-INFO"

echo "synced: $(ls "$DEST")  (vpython-jupyter $WHEEL_VERSION, source $SRC_SHA)"

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
  # BUILD-INFO too: the container is where a "what is actually serving?" question
  # gets asked, and the worktree copy answers for the worktree, not for this.
  docker cp "$DEST/BUILD-INFO" "$CONTAINER:$CDEST/"
  echo "copied into $CONTAINER:$CDEST/ — glowcomm_host.js, $WHEEL_BASE, BUILD-INFO"
fi
