# Browser smoke tests (spike)

Playwright golden-path tests that exercise the **client-side** journeys the vitest
`flow` harness structurally can't — editor prefill, running code, snapshot
rendering. These are the class of bug that only shows up in a real browser
(the New-Trinket "last trinket's code" prefill, blank WebVPython snapshots, the
embed dialog, iPad dividers).

## Why local docker stacks (not the deploy servers)

Run against a local `make gcp` stack, not the trials: hermetic (fresh state each
run), mirrors the Firestore/Firebase/Storage production shape, and — critically —
the **Firebase Auth emulator** lets us log in without a Google popup. Auth reuses
the exact seam the vitest harness uses (`flow.cjs` → mint verified ID token →
`POST /api/auth/session`), implemented in `global-setup.js`.

A thin set of checks against the deployed trial URL still has value for
deploy/config-specific things a local stack can't mirror (real GCS buckets, the
`deploys/` overlay) — but that's a separate, tiny smoke, not this suite.

## Running

```bash
# 1. Bring up the GCP-shape stack (from repo root). Builds host-native.
docker compose -f docker-compose.gcr.yml up --build -d

# 2. Install + run the browser tests
cd test/browser
npm install
npx playwright install chromium
npm test
```

Env knobs: `TRINKET_BASE_URL` (default `http://localhost:3001`),
`FIREBASE_AUTH_EMULATOR_URL` (default `http://localhost:9099`), `SMOKE_EMAIL`.

## Notes / findings from the spike

- **Platform:** the `app` service used to hard-code `platform: linux/arm64`, which
  forced QEMU on amd64 hosts (Intel intelmini, CI) and made the app time out
  reaching Firestore on boot. That pin is now removed — the stack builds
  host-native. Set `DOCKER_DEFAULT_PLATFORM=linux/amd64` only if you want
  deliberate Cloud-Run parity on an Apple-Silicon Mac.
- **WebGL:** headless Chrome renders glowscript/WebVPython via SwiftShader
  (`--use-angle=swiftshader`), so the snapshot path actually executes.
- **Auth:** open-signup on the stack (`requireApprovedAccount` off) means any email
  auto-creates an account on first `POST /api/auth/session`.
