#!/usr/bin/env bash
# Publish this deploy's static assets to Firebase Hosting's CDN.
#
# WHY THIS EXISTS
# ---------------
# Assets served *through* a Firebase Hosting rewrite inherit
#   vary: accept-encoding, cookie, need-authorization, x-fh-requested-host
# and a cookie-bearing request then bypasses the edge entirely. Since the app
# sets a session cookie on the home page, every real browser carries one, so a
# rewrite-only setup delivers nothing: measured 25/25 asset requests still
# reaching Cloud Run. Uploading the assets makes them STATIC files, which
# Hosting matches before it applies rewrites — same measurement afterwards:
# 25/25 served from the edge, 0 reaching Cloud Run.
#
# The upload is keyed to the deploy's commit, matching the /cache-prefix-<sha>/
# URLs the app emits (see lib/util/assetVersion.js), so each deploy publishes a
# fresh, immutable set and old ones simply stop being requested.
#
# USAGE
#   scripts/deploy-hosting.sh                     # infer commit from the service
#   COMMIT=abc1234 scripts/deploy-hosting.sh      # pin it explicitly
#   ASSET_SRC=/path/to/public scripts/deploy-hosting.sh   # skip image extraction
#
# ENV
#   FIREBASE_PROJECT   (required) Firebase/GCP project id
#   HOSTING_SITE       (required) Hosting site id
#   HOSTING_REWRITES   (required) the site's rewrites as JSON. `firebase deploy
#                      --only hosting` REPLACES the site's config, so whatever
#                      is passed here becomes the site's ONLY rewrites:
#                        front-door site (Hosting in front of the app):
#                          '[{"source":"**","run":{"serviceId":"<service>","region":"us-central1"}}]'
#                        assets-only site (no rewrites, on purpose):
#                          '[]'
#                      Required precisely so an assets upload can never
#                      silently strip the run rewrite off a front-door site.
#   SERVICE_URL        (required unless COMMIT and ASSET_SRC are both set)
#   IMAGE              container image to extract assets from (needs docker)
#   ASSET_SRC          a public/ directory to use instead of extracting
#   COMMIT             deploy commit; else read from ${SERVICE_URL}/version
set -euo pipefail

FIREBASE_PROJECT="${FIREBASE_PROJECT:?set FIREBASE_PROJECT}"
HOSTING_SITE="${HOSTING_SITE:?set HOSTING_SITE}"
HOSTING_REWRITES="${HOSTING_REWRITES:?set HOSTING_REWRITES — [] for an assets-only site, or the run-rewrite JSON for a front-door site. This deploy REPLACES the sites rewrites}"
SERVICE_URL="${SERVICE_URL:-}"
IMAGE="${IMAGE:-}"
ASSET_SRC="${ASSET_SRC:-}"
COMMIT="${COMMIT:-}"

# Small, always-requested tiers. components/ is deliberately NOT wholesale: it
# is ~441 MB of source trees in the image and almost none of it is ever fetched.
ASSET_DIRS="${ASSET_DIRS:-css js img fonts partials}"

# Pages crawled to discover which components/ files this deploy actually
# references. Anything missed simply falls through to the origin and still
# works — uncached, not broken.
CRAWL_PATHS="${CRAWL_PATHS:-/ /embed/python3 /embed/glowscript /embed/pyodide}"

say() { printf '  %s\n' "$*"; }

# --- 1. which commit are we publishing for? -------------------------------
if [[ -z "${COMMIT}" ]]; then
  [[ -n "${SERVICE_URL}" ]] || { echo "Need COMMIT or SERVICE_URL" >&2; exit 1; }
  COMMIT=$(curl -fsS --max-time 60 "${SERVICE_URL}/version" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"])')
fi
[[ -n "${COMMIT}" && "${COMMIT}" != "unknown" ]] || {
  echo "Refusing to publish: the deploy reports commit '${COMMIT}'." >&2
  echo "Assets would be uploaded under a prefix the app never emits." >&2
  exit 1
}
say "publishing assets for commit ${COMMIT}"

# --- 2. get the BUILT assets ----------------------------------------------
# The checkout is not enough: base.css and components/ are produced at image
# build time, so the host tree has ~96 KB of css where the image has 652 KB.
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

if [[ -n "${ASSET_SRC}" ]]; then
  say "using assets from ${ASSET_SRC}"
  SRC="${ASSET_SRC}"
else
  [[ -n "${IMAGE}" ]] || { echo "Need IMAGE or ASSET_SRC" >&2; exit 1; }
  command -v docker >/dev/null || { echo "docker required to extract ${IMAGE}" >&2; exit 1; }
  say "extracting public/ from ${IMAGE}"
  docker pull -q "${IMAGE}" >/dev/null
  cid=$(docker create "${IMAGE}")
  docker cp "${cid}:/usr/local/node/trinket/public" "${WORK}/public" >/dev/null
  docker rm -f "${cid}" >/dev/null
  SRC="${WORK}/public"
fi

# --- 3. stage under the versioned prefix AND at bare paths ------------------
# Bare paths matter as much as the stamped ones: embed pages reference ~33
# files as plain /js/... and /components/... (no cache-prefix), and every one
# of those otherwise rides the rewrite to the origin on every view. Measured
# 2026-08-24: a 1000-student cold herd shed glow.min.js for 17% of students —
# all on bare-path files. Hosting matches static files BEFORE rewrites, so
# publishing them here moves that whole class of traffic to the edge with no
# app change. Bare paths get a SHORT max-age (they change in place across
# deploys); each hosting deploy also purges Firebase's CDN.
SITE="${WORK}/site"
PREFIX="${SITE}/cache-prefix-${COMMIT}"
mkdir -p "${PREFIX}"
for d in ${ASSET_DIRS}; do
  [[ -d "${SRC}/${d}" ]] && cp -R "${SRC}/${d}" "${PREFIX}/" && cp -R "${SRC}/${d}" "${SITE}/"
done

if [[ -n "${SERVICE_URL}" ]]; then
  refs="${WORK}/refs"; : > "${refs}"
  for p in ${CRAWL_PATHS}; do
    curl -fsS --max-time 60 "${SERVICE_URL}${p}" 2>/dev/null \
      | grep -oE '(/cache-prefix-[^"'"'"' ]+|/components/[^"'"'"' ]+)' >> "${refs}" || true
  done
  n=0
  while read -r f; do
    [[ -f "${SRC}/${f}" ]] || continue
    mkdir -p "${PREFIX}/$(dirname "${f}")" "${SITE}/$(dirname "${f}")"
    cp "${SRC}/${f}" "${PREFIX}/${f}"
    cp "${SRC}/${f}" "${SITE}/${f}" && n=$((n+1))
  done < <(sed 's|^/cache-prefix-[^/]*/|/|' "${refs}" \
             | grep -oE '^/components/[^"'"'"' ]+' | sed 's|^/||' | sort -u)
  say "components referenced by this deploy: ${n} (published stamped AND bare)"
fi

say "staged $(find "${SITE}" -type f | wc -l | tr -d ' ') files, $(du -sh "${SITE}" | cut -f1)"

# --- 4. hosting config ----------------------------------------------------
# Static files win over rewrites, so the versioned assets never become rewrite
# responses. Everything else falls through to the app.
# Firebase applies its own max-age=3600 to uploaded files, overriding whatever
# the app would have sent — so the immutable header is restated here.
cat > "${WORK}/firebase.json" <<JSON
{
  "hosting": {
    "site": "${HOSTING_SITE}",
    "public": "site",
    "ignore": ["**/.*"],
    "headers": [
      { "source": "/cache-prefix-*/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
      { "source": "!/cache-prefix-*/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] }
    ],
    "rewrites": ${HOSTING_REWRITES}
  }
}
JSON

say "deploying to ${HOSTING_SITE} (${FIREBASE_PROJECT})"
( cd "${WORK}" && firebase deploy --only hosting --project "${FIREBASE_PROJECT}" )

if [[ -n "${SERVICE_URL}" ]]; then
  say "verify:  curl -sSI -H 'Cookie: x=1' <host>/cache-prefix-${COMMIT}/css/base.css"
  say "         expect 'x-cache: HIT' on the second request and NO 'cookie' in vary"
fi
