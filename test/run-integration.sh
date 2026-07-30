#!/usr/bin/env bash
# Server-level integration suite, run inside the Cloud-Run-shaped test container
# (node:20 amd64 + the standalone Firestore emulator jar + firebase-tools). One
# database/auth profile per invocation — the same profiles CI runs:
#
#   test/run-integration.sh mongo          # default backend, mongodb-memory-server
#   test/run-integration.sh firestore      # Firestore emulator (the backend Cloud Run deploys)
#   test/run-integration.sh firebase-auth  # Firestore + Firebase Auth emulators (the login seam)
#
# Extra args after the profile are passed through to vitest, e.g.
#   test/run-integration.sh firestore test/lib/workers/exports.test.js
#
# Env:
#   DEPS_VOLUME  docker volume holding the container's (amd64) node_modules.
#                Default: gcr-base-nm. Auto-populated via `npm ci` if empty, so
#                a fresh machine works too (first run is slow).
#
# Invoked by `make test-mongo|test-firestore|test-firebase-auth`.
set -euo pipefail

PROFILE="${1:-}"; shift || true
case "$PROFILE" in
  mongo|firestore|firebase-auth) ;;
  *) echo "usage: $(basename "$0") <mongo|firestore|firebase-auth> [vitest args]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
IMAGE=trinket-test-firestore
DOCKERFILE=test/firestore-emulator.Dockerfile
VOL="${DEPS_VOLUME:-gcr-base-nm}"
PLAT=linux/amd64
EXTRA="$*"

# 1. Build the test image if it isn't present.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "--- building $IMAGE (first run) ---"
  docker build --platform "$PLAT" -t "$IMAGE" -f "$DOCKERFILE" .
fi

DRUN=(docker run --rm --platform "$PLAT"
  -v "$ROOT":/app -v "$VOL":/app/node_modules -w /app
  -e XDG_CACHE_HOME=/app/node_modules/.firebase-cache)

# 2. Populate the deps volume once (native amd64 modules) if it's empty.
if ! "${DRUN[@]}" "$IMAGE" bash -lc '[ -d node_modules/vitest ]' >/dev/null 2>&1; then
  echo "--- installing deps into volume '$VOL' (first run, slow) ---"
  "${DRUN[@]}" "$IMAGE" bash -lc 'npm ci --legacy-peer-deps'
fi

# 3. Mask config/local.yaml for the run: its overlay flips the backend to real
#    GCP credentials, which crashes the emulator profiles. Always restored.
restore() { [ -f config/local.yaml.itest ] && mv config/local.yaml.itest config/local.yaml; }
trap restore EXIT
[ -f config/local.yaml ] && mv config/local.yaml config/local.yaml.itest

case "$PROFILE" in
  mongo)
    echo "--- vitest (mongo / mongodb-memory-server) ---"
    "${DRUN[@]}" "$IMAGE" bash -lc "npx vitest run $EXTRA"
    ;;
  firestore)
    echo "--- vitest (Firestore emulator jar) ---"
    "${DRUN[@]}" "$IMAGE" bash -lc '
      java -jar /emulator/firestore.jar --host 127.0.0.1 --port 8089 >/tmp/fs.log 2>&1 &
      until curl -s 127.0.0.1:8089 >/dev/null; do sleep 0.5; done
      echo "firestore emulator up"
      TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 \
        npx vitest run --fileParallelism=false '"$EXTRA"
    ;;
  firebase-auth)
    echo "--- vitest (Firestore + Firebase Auth emulators) ---"
    "${DRUN[@]}" "$IMAGE" bash -lc '
      firebase emulators:start --only auth,firestore --project demo-trinket >/tmp/emu.log 2>&1 &
      until curl -s 127.0.0.1:9099 >/dev/null && curl -s 127.0.0.1:8080 >/dev/null; do sleep 1; done
      echo "auth + firestore emulators up"
      TEST_DB_BACKEND=firestore TEST_AUTH_PROVIDER=firebase \
      FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
      GOOGLE_CLOUD_PROJECT=demo-trinket \
        npx vitest run --fileParallelism=false '"$EXTRA"
    ;;
esac
