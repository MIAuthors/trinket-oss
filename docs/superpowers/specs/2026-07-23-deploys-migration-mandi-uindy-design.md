# Migrate mandi & uindy onto the `deploys/<name>/` overlay mechanism

**Date:** 2026-07-23
**Related:** picup issue #62 · trial-gcr pilot · `2026-07-23-config-firebase-providers-design.md` (Track 1)
**Status:** design — awaiting review

## Goal

Move the mandi and uindy Cloud Run deployments off their ad-hoc root-level
`config/local-production.yaml` + `.env` and onto the **`deploys/<name>/`** overlay
mechanism (`config/deploy-dir.js`, `TRINKET_DEPLOY=<name>`), the same way the
**trial-gcr** pilot already works. This makes per-deploy config a single,
version-controlled, backed-up unit (the private deploy repos) instead of loose
gitignored files at the app-repo root.

**Non-goal:** changing what any deployment actually *does*. The migration must be
**config-neutral** — effective runtime config identical before and after.

## Current state (verified 2026-07-23)

- **Mechanism is complete** — the overlay already supports every concern these
  deploys use:
  - config: `deploys/<name>/config/*.yaml` deep-merged (`deploy-dir.js`)
  - branding: `deploys/<name>/public/` served ahead of stock (`routeParser.js:691`)
  - templates: `deploys/<name>/views/` shadow stock (`nunjucks.js:10`)
  - secrets/LTI key: via **env** (`LTI_PRIVATE_KEY`, `FIREBASE_CLIENT_CONFIG`)
    sourced from the private repo `.env` at deploy time → Secret Manager.
    `.dockerignore` drops `.env`, so secrets never ship in the image; only
    yaml/public overlays do (`Dockerfile:64` `COPY . .`).
- **Private repos already have the right shape:**
  - `deploy-mandi` → `git@github.com:MIAuthors/trinket-deploy.git`
  - `deploy-uindy` → `git@github.com:UINDY-INSTRUCTORS/uindy-trinket-deploy.git`
  - Both contain `.env`, `README.md`, `config/local-production.yaml`,
    `config/local-development.yaml`, `public/img/brand/logo.png`
    (mandi also `lti-private-key.pem`).
- **Config-neutrality check (root worktree vs private-repo copy):**
  - uindy: **identical** ✅
  - mandi: **drift** — the live root copy and the private-repo copy differ, and
    both private clones currently have uncommitted `M config/local-production.yaml`.
- **No host-specific keys in the overlays** — `app.url.knownHosts` only, no
  `app.url.hostname` (which `NODE_CONFIG` patches per service). So the
  overlay-wins-over-NODE_CONFIG hazard called out in `deploy-dir.js` does not
  apply here. Keep it that way (never add `app.url.hostname` to an overlay).

## Key risk: double-source config

`deploy-dir.js` deep-merges the overlay **on top of** the root
`config/local-production.yaml` that node-config already loaded. If both remain,
both apply (overlay wins conflicts) — a confusing two-source state. Therefore the
migration must **retire the root `config/local-production.yaml` + `.env`** so the
overlay is the *only* source. (They are gitignored — back them up before removing.)

## Decisions (confirmed with Steve)

1. **Populate `deploys/<name>/` by fresh `git clone`** of the private repo into
   each worktree (mirrors trial-gcr; each worktree self-contained). The existing
   `../deploy-mandi` / `../deploy-uindy` clones stay as backups.
2. **Live root worktree config is authoritative** for reconciling mandi's drift.
   Sync the private repo to match the running config; the diff is shown for the
   record during implementation but root wins.

## Plan of record (per deploy)

For `<name>` in {mandi, uindy}, in the `gcr-<name>` worktree:

1. **Clone overlay:** `git clone <private-repo> deploys/<name>` inside the worktree.
   (`deploys/` is gitignored in the app repo → nested clone is fine.)
2. **Reconcile config-neutral:**
   - uindy: already identical — just confirm `diff` is empty.
   - mandi: `diff` live root vs cloned overlay; **make the overlay equal the live
     root** (root wins); commit the reconciled config to the private repo.
3. **Set `TRINKET_DEPLOY=<name>`** in `deploys/<name>/.env` (as trial-gcr does).
4. **Retire root sources:** back up then remove the worktree's root
   `config/local-production.yaml` and `.env` so config comes only from the overlay.
5. **Deploy candidate:** `TRINKET_DEPLOY=<name> bash deploy-cloudrun.sh` with
   **`NO_TRAFFIC=1`** → candidate revision. Verify (login page, branding, LTI,
   a known trinket loads). **Promote only on Steve's explicit per-deploy go.**

## Test on gcr-trial first

gcr-trial already runs on `deploys/trial-gcr`, so validate the *approach* +
Track-1 auth change there before any prod cutover:

1. Land Track 1's config-driven `signInOptions` code change on the app branch.
2. Add `auth.firebase.providers: ['google']` to
   `deploys/trial-gcr/config/local-production.yaml`.
3. Deploy trial; confirm the login page shows Google-only (then revert/verify both
   works). This proves the code change **and** that an overlay carries the
   auth-provider value end-to-end.

## Relationship to Track 1 (auth providers)

- Track 1 (committed code: `default.yaml` + `auth.loginPage` + `login-firebase.html`)
  is independent and merges to picup regardless.
- This migration is the *config-delivery* change. Once migrated, uindy's
  `providers: ['google']` lives in `deploys/uindy/config/local-production.yaml`;
  mandi inherits both (or sets them explicitly there).
- **Order:** Track 1 first (small, trial-testable), then this migration.

## Rollback

Each step is reversible per deploy:
- Cloud Run keeps the prior revision — `update-traffic` back to it instantly.
- The retired root `config/local-production.yaml` + `.env` are backed up; restore
  them and unset `TRINKET_DEPLOY` to return to the pre-migration path.
- No traffic shifts until explicit promotion, so a bad candidate never serves.

## Verification checklist (per deploy, on the candidate before promote)

- `diff` proves config-neutrality (effective config unchanged).
- Login page renders (correct providers, branding/logo present).
- LTI JWKS endpoint + a launch still work (key loaded from env/secret).
- A known course/trinket loads (Firestore backend, gcs assets).
- Logs clean on startup (`[deploy-dir] merged …` lines present; no config errors).

## Out of scope

- test-vps / gopicup migrations (separate; gopicup is picup #62 Lane A already).
- Any change to deploy *behavior*, branding, or features.
- Consolidating the private repos or CI for them.
