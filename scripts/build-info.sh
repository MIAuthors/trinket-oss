#!/usr/bin/env bash
# Stamp the build identity that GET /version reports.
#
# Writes build-info.json (gitignored) into the repo root, from where `COPY . .`
# bakes it into the image. Run this immediately before building:
#
#   Cloud Run:   deploy-cloudrun.sh calls it before `gcloud builds submit`
#   self-host:   bash scripts/build-info.sh && docker compose up -d --build
#
# Why a file rather than --build-arg: `gcloud builds submit --tag` has no way to
# pass build args, and this works identically for every build path (Cloud Build,
# compose, bare node) with no cloudbuild.yaml. Env vars still win at runtime if
# set (see lib/util/buildInfo.js), so a container CAN be overridden without a
# rebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
# On a detached HEAD (how the trial deploys check out) rev-parse --abbrev-ref
# prints "HEAD"; fall back to any branch/tag pointing at this commit.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$BRANCH" = "HEAD" ]; then
  BRANCH="$(git describe --all --exact-match HEAD 2>/dev/null | sed 's|^heads/||; s|^tags/||' || echo detached)"
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > build-info.json <<EOF
{
  "commit": "${COMMIT}",
  "branch": "${BRANCH}",
  "builtAt": "${BUILT_AT}"
}
EOF

echo "build-info.json: ${COMMIT:0:7} (${BRANCH}) built ${BUILT_AT}"
