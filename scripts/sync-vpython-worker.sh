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
