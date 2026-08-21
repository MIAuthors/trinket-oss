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
`deploys/` overlay) — that suite now exists as `specs-deploy/`, described below.

## Running

```bash
# 0. The stack interpolates the gitignored root .env (SESSION_PASSWORD,
#    FIREBASE_CLIENT_CONFIG — see the Makefile header). Fresh worktrees don't
#    have it: copy it from the base clone, and copy config/local.example.yaml
#    to config/local.yaml (plus any feature flags the specs need, e.g.
#    features.workerVPython). Without FIREBASE_CLIENT_CONFIG the UI login page
#    is broken — the SPECS still pass, because global-setup mints emulator
#    tokens directly and never sees the login page.

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

## Deploy smoke (`specs-deploy/`)

Runs against a **real** deployment rather than a local stack. Every test is
anonymous and read-only, so it is safe to point at a running server:

```bash
cd test/browser
TRINKET_BASE_URL=https://trial-merge.spvi.net      npx playwright test -c playwright.deploy.config.js
TRINKET_BASE_URL=https://rba-merge-trial.spvi.net  npx playwright test -c playwright.deploy.config.js

# assert a specific build is live
EXPECT_COMMIT=7f5e205 TRINKET_BASE_URL=... npx playwright test -c playwright.deploy.config.js
```

It answers the questions a local stack cannot:

* **is this the build I deployed?** `/version` must report a real commit, and
  `commitSource` distinguishes a stamped image from a stale `build-info.json`;
* **is it in production mode?** a deploy with `NODE_ENV` unset silently loses
  view caching, `local-production.yaml`, and route gating (issue #111);
* **does this server send the right headers?** normal embeds keep remote images
  but never frames; `runMode=calculator` allows neither third-party images nor
  general network egress;
* **do the trinket types it serves actually work?** a WebVPython scene renders a
  sized WebGL canvas, and a python3 program prints — the latter proving the
  deploy's policy permits pyodide to fetch its runtime and wheels;
* **is a program prevented from pulling in third-party content?** the injected
  iframe is refused by the deployed policy, not merely by the code.

Deliberately excluded: anything requiring a login (no auth emulator on a real
server) and anything that writes. Keep it that way — this suite should stay safe
to run against production.

### Front-door tests (`front-door.spec.js`)

A deployment may sit behind a CDN or proxy. When it does, the app receives the
BACKEND's host rather than the browser's, and any absolute URL it renders points
at a foreign origin — Angular then refuses the embed iframe as `[$sce:insecurl]`
and the trinket never renders.

The rest of the deploy smoke cannot see this: those tests navigate to
`/embed/...` URLs they build themselves, so nothing exercises a page where the
CLIENT builds the URL. Behind a broken CDN front door the suite passed 8/8 while
the library page was dead.

Two of these tests need no fixture and run against any deployment. The third
needs a public trinket, since there is no anonymous listing to crawl:

```bash
SMOKE_TRINKET_PATH=/library/trinkets/<id> \
TRINKET_BASE_URL=https://<host> \
  npx playwright test -c playwright.deploy.config.js specs-deploy/front-door.spec.js
```

Both fixture-free tests were verified RED by rolling a deployment back to the
pre-fix revision, then GREEN again — worth repeating if they are ever changed,
since an earlier draft of the leak check matched only `https://` URLs and passed
against a genuinely broken build.
