# GCP / Firestore toolchain — where it belongs (disposition map)

_Decision aid, 2026-08-01. "Map it, don't build yet." No PRs opened from this._

## The question
Now that `picup/main` is the **unified multi-backend codebase** (people choose Mongo *or*
Firestore at deploy time), where does the GCP/Firestore-specific toolchain live? In
particular: should there be a **separate long-lived branch** on `PICUP-Physics/trinket-oss`
for GCP-specific artifacts?

## Governing principle
**Toolchain follows the code.** `picup/main` already ships Firestore as a first-class
backend (`lib/db/backend-factory.js` selects `firestore | mongoose`;
`firestore-backend.js`, `firestore.rules`, `firestore.indexes.json`,
`test/firestore-emulator.Dockerfile`, and the `TEST_DB_BACKEND=firestore` switch in
`test/helpers/vitest-setup.cjs` are all upstream). Tests/CI for a backend must live with
the code they test, or they test a snapshot of nothing.

## Should there be a separate GCP branch on picup? **No.**
1. **Drift.** A long-lived branch must be perpetually rebased onto `main` — reintroducing
   exactly the fork-maintenance burden the `deploys/<name>/` overlay approach was built to
   eliminate. Step backward for the "sell colleagues a clean, low-maintenance approach" goal.
2. **CI on a branch tests a frozen copy of main, not main.** So `main`'s Firestore backend
   would ship *untested by main's own CI*. The regression class this tooling exists to catch
   (Mongo silently ignores `undefined` query values; Firestore throws) would still slip into
   `main`.
3. **Same fragmentation, relocated.** An adopter clones `main`, gets the Firestore backend
   but not its tooling → they must discover the branch. That's the "come to MIAuthors for the
   full suite" problem moved from another repo to another branch.
4. **It's mostly already in `main` anyway** (see inventory) — a branch would *un-unify* what's
   already unified.

**The real concern a branch is trying to solve** — don't tax Mongo-only contributors with
Firestore CI minutes — is solved without a branch:
- **Opt-in CI**: matrix leg gated by `workflow_dispatch` / label / path filter / deploy tag.
  (`browser-smoke.yml` already does this: `workflow_dispatch` + `push: tags:[deploy-*]` only —
  it does **not** run on ordinary pushes.)
- **Config-driven backend**: Mongo deployers simply never set `db.backend=firestore`.

## Inventory — what's already in `picup/main` vs missing
| Artifact | On `picup/main`? |
|---|---|
| `lib/db/{backend-factory,firestore-backend,mongoose-backend}.js` | ✅ |
| `firestore.rules`, `firestore.indexes.json` | ✅ |
| `test/firestore-emulator.Dockerfile`, `test/lib/db/firestore-backend.test.js` | ✅ |
| `test/helpers/vitest-setup.cjs` `TEST_DB_BACKEND=firestore` switch | ✅ |
| `deploy-cloudrun.sh`, `docker-compose.gcr.yml`, `Makefile`, `config/deploy-dir.js` | ✅ |
| routeParser `undefined ? null` hardening | ✅ (via `bdb0d48`, #58 defense-in-depth) |
| **Firestore CI leg** (`test.yml` mongo+firestore matrix — `2f275a6`) | ❌ **missing** |
| `cloudbuild.yaml` | ❌ missing |
| Browser smoke suite (`test/browser/`) | ❌ (in flight as **PR #84**) |

**Takeaway:** the GCP toolchain is ~90% already upstream. What's genuinely missing from
`main` is essentially just the **Firestore CI leg** (and `cloudbuild.yaml`). No branch needed
— just close the small gap in `main`, opt-in.

## Per-artifact disposition (when you decide to build)
| Item | Home | Notes |
|---|---|---|
| Firestore CI matrix (`2f275a6`) | `picup/main`, **opt-in leg** | Tests main's Firestore backend. Gate the Firestore job so Mongo-only pushes don't pay for it. |
| routeParser fix `fdbdf8e` + coverage `07f0c41` | **likely redundant upstream** | `picup/main` already hardens this class via `bdb0d48` (#58). Keep on the gcr fork; only PR if a real Firestore run shows a path `bdb0d48` misses. |
| Browser smoke (`test/browser/`) | `picup/main` — **PR #84** (open, draft) | On-demand CI already. Part of the shared supported toolchain. |
| `cloudbuild.yaml` | `picup/main` (opt-in / documented) | Generic Cloud Run build; any GCP adopter uses it. |
| Per-site config (branding, buckets, secrets, announcement) | `deploys/<name>/` overlay (private repo) | Already the design (#68, #83). Never in `main`, never in a branch. |

## Dependency to remember (Firestore CI green-ness)
- The Firestore leg only passes **New-Trinket** because of the `undefined?null` reply-shim
  hardening. That protection **is already on `picup/main`** (`bdb0d48`), so the CI PR may well
  stand alone — **confirm by actually running the Firestore leg against `picup/main`; that's
  the PR's job.**
- It `skipIf(firestore)`s the **slug-alias redirect** test → the `post('init')` hooks gap
  (renamed slug 404s instead of 301 on Firestore). So turning on Firestore CI upstream
  **proves #69's slug-alias fix is incomplete on Firestore.** Carry the skip + a tracked
  follow-up, or fix the postinit gap first.

## Suggested sequence (if/when you build)
1. **Firestore-CI PR** (`2f275a6`) → `picup/main`, Firestore job opt-in. Let its own run tell
   you whether `bdb0d48` already makes New-Trinket green (expected yes).
2. If that run reveals a gap `bdb0d48` doesn't cover → small routeParser PR (`fdbdf8e`+`07f0c41`).
3. **#84** browser smoke → mark ready once happy.
4. **postinit-hooks gap** → separate follow-up to un-skip the slug-alias test on Firestore.
