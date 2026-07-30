#!/usr/bin/env bash
# Browser smoke tests against a local GCP-shape stack (Firestore + Firebase-Auth +
# Storage emulators). Brings the stack up, runs the Playwright suite, tears it
# down — regardless of pass/fail. Intended as a pre-deploy gate, run on demand
# (see `make browser-smoke`), NOT on every push.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
COMPOSE="docker compose -f docker-compose.gcr.yml"

cleanup() { echo "--- tearing down stack ---"; $COMPOSE down >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "--- bringing up the gcp stack (host-native) ---"
$COMPOSE up --build -d

echo "--- waiting for the app on :3001 ---"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://localhost:3001/ 2>/dev/null || true)
  if [ "$code" = "200" ] || [ "$code" = "302" ]; then echo "app up ($code)"; break; fi
  if [ "$i" = "60" ]; then echo "!! app did not come up"; docker logs trinket-gcr --tail 25 2>&1 || true; exit 1; fi
  sleep 3
done

echo "--- running browser smoke tests ---"
cd test/browser
[ -d node_modules ] || npm install
npx playwright install chromium >/dev/null 2>&1 || true
npx playwright test "$@"
