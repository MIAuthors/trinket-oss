#!/usr/bin/env bash
# Fetch the vpython-jupyter worker assets (pure wheel + glowcomm_host.js) from
# the PINNED upstream release into trinket's served components, for local dev.
# The Dockerfile does the same fetch for images — its ARG block is the single
# source of truth for release tag and sha256s; this script parses it so the
# two can never drift.
#
# public/components is gitignored (and gcloudignored): these files are never
# committed — the release asset, pinned by sha256, IS the artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/components/vpython-worker"
DOCKERFILE="$ROOT/Dockerfile"
PYODIDE_JS="$ROOT/public/js/embed/pyodide.js"
mkdir -p "$DEST"

arg() {
  sed -n "s/^ARG $1=\(.*\)$/\1/p" "$DOCKERFILE" | head -1
}
RELEASE=$(arg VPYTHON_WHEEL_RELEASE)
WHEEL_SHA=$(arg VPYTHON_WHEEL_SHA256)
GHOST_SHA=$(arg GLOWCOMM_HOST_SHA256)
if [ -z "$RELEASE" ] || [ -z "$WHEEL_SHA" ] || [ -z "$GHOST_SHA" ]; then
  echo "FAILED: could not read VPYTHON_WHEEL_RELEASE / *_SHA256 ARGs from $DOCKERFILE" >&2
  exit 1
fi

# The page fetches ONE hard-coded filename. Read it rather than guessing: a
# version bump that only happens on one side produces a 404 at run time, which
# surfaces to a student as "This is a site problem" with nothing at the cause.
WHEEL_NAME=$(sed -n "s/^var VPYTHON_WHEEL_NAME = '\(.*\)';.*/\1/p" "$PYODIDE_JS")
if [ -z "$WHEEL_NAME" ]; then
  echo "FAILED: could not read VPYTHON_WHEEL_NAME from $PYODIDE_JS" >&2
  exit 1
fi

BASE="https://github.com/vpython/vpython-jupyter/releases/download/$RELEASE"
echo "Fetching $RELEASE assets into $DEST"
curl -fL --silent -o "$DEST/$WHEEL_NAME"      "$BASE/$WHEEL_NAME"
curl -fL --silent -o "$DEST/glowcomm_host.js" "$BASE/glowcomm_host.js"
echo "$WHEEL_SHA  $DEST/$WHEEL_NAME"      | shasum -a 256 -c -
echo "$GHOST_SHA  $DEST/glowcomm_host.js" | shasum -a 256 -c -
echo "OK: $WHEEL_NAME + glowcomm_host.js pinned at $RELEASE"
