# Handoff: database leak fixes

**Written** 2026-07-28, on a Mac, to be picked up on **intelmini** (where the
deploy branches and their `.env`/`deploys/` material are configured).

Companion documents — read them in this order if you are cold:

1. `docs/superpowers/plans/2026-07-27-db-leak-fixes.md` — the full plan, the
   measured baseline, per-task detail, and the production rollout notes. This
   handoff does not repeat any of it.
2. `docs/ENVIRONMENTS.md` — on branch `docs/environments`, not on this branch.
   The five servers, the two stack shapes, and the local→staging→production
   columns.

---

## Status in one paragraph

Four fixes are implemented, unit-tested, and verified on a live local stack.
Nothing has been deployed anywhere. The remaining work is **Task 5** — real LTI
launches against trial-merge, which is the only environment with a co-located
Canvas — followed by opening the PR to `picup-physics/trinket-oss` and the
manual production steps in the plan's rollout section.

Nothing here is urgent. The entire measured leak across all five servers is
under a megabyte. This is pre-Fall hygiene, and the plan says so.

---

## Branches

Both are pushed to `origin` (`MIAuthors/trinket-oss`). Neither has a PR open.

| Branch | Commits | Base | Contents |
|---|---|---|---|
| `fix/collection-expiry` | 9 | `main` @ `3b6feb9` | the four fixes, their tests, the plan, this handoff |
| `docs/environments` | 1 (`24eb774`) | `main` @ `3b6feb9` | `docs/ENVIRONMENTS.md` |

They are deliberately separate. `fix/collection-expiry` goes to picup as one
coherent change; the environments doc is internal orientation and does not
belong in a maintainer's review queue.

Diffstat of `fix/collection-expiry` against `main`:

```
 docs/superpowers/plans/2026-07-27-db-leak-fixes.md | 866 +++++++++++++++
 firestore.indexes.json                             |  12 +-
 lib/models/errorEvent.js                           |   6 +
 lib/models/ltiNonce.js                             |  16 +-
 lib/util/catbox-mongoose.js                        |  46 +-
 test/helpers/mongo-global.mjs                      |  10 +-
 test/lib/models/ltiNonce.test.js                   |  88 +
 test/lib/models/telemetry-retention.test.js        |  82 +
 test/lib/util/catbox-mongoose.test.js              |  97 +
```

`test/helpers/mongo-global.mjs` is the shared harness: it now starts `mongod`
with `--setParameter ttlMonitorSleepSecs=1` so TTL deletion is testable in
milliseconds instead of the ~60s default. Setting it after boot does not work —
it only takes effect after the monitor's current sleep finishes.

---

## What is verified, and at what level

| Level | Result |
|---|---|
| Unit, mongoose profile | 257 pass |
| Unit, Firestore profile | 241 pass |
| Deployed container (`make mongo`) | `expiresAt` stamped as a `Date`; `get()` round-trips |
| Stock `mongo:5`, default 60s monitor | session **reaped after ~105s** |
| Firestore TTL policy on `trinket-merge-test` | state **ACTIVE** |

Both suites were run from a `linux/amd64` image built from an unmodified
`package-lock.json`. If you rebuild on intelmini, use `npm ci`, not
`npm install` — `install` rewrites the lockfile (it downgraded `gcp-metadata`
6.1.1 → 5.3.0 once already).

---

## Deploy topology — read this before merging anything

The branch relationships were measured against `origin` on 2026-07-28. Two of
them do not match the obvious mental model.

**`convergence/gcr-to-picup` is stale.** It last moved 2026-07-14, sits 35
commits behind `main`, and carries **zero** commits that `main` does not already
have. It is not the integration branch anymore.

**`trial/rba-merge-integration` is the living integration branch.** Its history
is a run of `Merge branch '<feature>' into trial/rba-merge-integration`, it is 30
commits ahead of `main`, and the `gcr-trial` worktree tracks it.

**`deploy-preview` is a strict ancestor of it** — 7 commits behind, nothing
unique of its own. So it genuinely can be fast-forwarded.

```
main ──┬── deploy-preview ── (+7) ── trial/rba-merge-integration
       ├── deploy-mandi   (+21, diverged)
       ├── deploy-uindy   (+21, diverged)
       └── fix/collection-expiry (+9)
```

`deploy-mandi` and `deploy-uindy` each carry 21 unique commits and differ from
each other by 16/16 — per-deploy configuration. They are merge targets, never
fast-forward targets. They are production and are out of scope for this pass.

### The sequence that follows from that

```bash
# 1. Integration branch takes the fix. A real merge, not a fast-forward.
#    Verified conflict-free with `git merge-tree` on 2026-07-28: none of the
#    files this branch touches appear in trial/rba's 30 commits.
git checkout trial/rba-merge-integration
git merge origin/fix/collection-expiry

# 2. The Mongo staging branch fast-forwards to it.
git checkout deploy-preview
git merge --ff-only trial/rba-merge-integration
```

Step 2 is a genuine fast-forward, but note what it carries: `deploy-preview`
picks up the **7 commits already on the canary** as well as the fix — the
Playwright browser-smoke spike, the Firestore post-`init` hook fix, and the
Firestore-profile CI job. If you want trial-merge to move by the TTL fix alone,
merge `fix/collection-expiry` into `deploy-preview` directly instead and let the
two staging branches diverge for the duration of the test. That merge is also
conflict-free (checked the same way).

That is a real choice, not a formality. The fast-forward is simpler; the direct
merge gives a cleaner read on what caused any behaviour change during Task 5.

### Which column each fix actually lands on

| Task | File | Mongo column | Firestore column |
|---|---|---|---|
| 1 — sessions | `lib/util/catbox-mongoose.js` | **yes** — this is the Mongo session engine | n/a |
| 2 — nonce model | `lib/models/ltiNonce.js` | yes | yes (the model layer is shared) |
| 3 — nonce TTL policy | `firestore.indexes.json` | n/a | **yes** |
| 4 — telemetry | `lib/models/errorEvent.js` | yes | **no — see gap below** |

Task 5 needs trial-merge specifically because Canvas lives on that host, and
because the sessions leak is a Mongo-column problem with production evidence.

---

## What is left

**Task 5 — LTI launches on trial-merge.** Full checklist is in the plan under
"Task 5: Verify on the Mongo test server". Deploy is on `webapps` at
`/home/steve/docker/trinket-trial`, compose project `trinket-trial`. Reach the
database with
`ssh webapps 'docker exec mongodb mongo trinket --quiet --eval "<js>"'`.

The one thing worth knowing up front: **trial-merge has no `ltinonces`
collection at all** right now, and 0 sessions. You will watch both appear from
nothing, which means you must generate the traffic before any count means
anything. Verifying against an empty collection proves nothing.

**Open the PR.** `MIAuthors:fix/collection-expiry` → `picup-physics:main`,
cross-repo. Direct pushes to `picup` return 403 — read-only access. Four other
PRs are already open there (#65, #67, #68, #69), which is the reason this branch
was kept to one concern.

**Production rollout**, after the PR lands — both steps are manual and neither
happens on deploy:

- `db.sessions.dropIndex('stored_1')`. Mongoose's `autoIndex` creates missing
  indexes but **never drops** removed ones, so production will carry both the
  old broken index and the new working one. The test suite cannot catch this:
  tests call `syncIndexes()`, which does drop.
- A one-off purge of the pre-existing sessions. 494 of picup's 797 are already
  older than 30 days and have no `expiresAt`, so TTL will never touch them.

---

## Known gaps and loose ends

**`errorevents` has no Firestore TTL policy.** Task 4 adds a 400-day Mongo TTL
index, and `firestore.indexes.json` gained a `fieldOverrides` entry for
`ltinonces` only. On the Firestore column the telemetry expiry therefore does
nothing. It is zero documents on all five servers today, so this is a gap to
name rather than a bug to chase — but it should not be assumed covered.

**Incidental findings, deliberately left unfixed** (out of scope for a PR about
expiry):

- `lib/models/errorEvent.js` declares `code: { type: String, required: true,
  default: '' }`. Mongoose's `required` rejects the empty string, so the default
  can never satisfy the validator. Test fixtures set `code` explicitly.
- `docker-compose.yml` forwards neither `SESSION_PASSWORD` nor `ADMIN_EMAILS`,
  so a local stack silently gets `adminEmails: []` no matter what `.env` says.

**Deliberately out of scope** (reasoning recorded in the plan): `clientMetric`
retention — it upserts one document per minute rather than appending, and sets
`timestamps: false` so it has no `created` field; the `exports` sweeper; and
nonce uniqueness / TOCTOU.

**Local cruft on the Mac**, not on any server: a `ttl-tester@localhost.test`
account in the local mongo volume, created because the only existing account was
`source: "firebase"` and the bcrypt middleware is a no-op for firebase / google /
lti accounts.

---

## Machine notes

Everything above was done on a Mac. `gcr-firestore-base` work normally happens on
intelmini, and versions differ between the two. The Docker images here were built
`linux/amd64` deliberately — both VPS hosts are `x86_64`, and no
`mongodb-linux-aarch64-debian11-6.0.14` build was ever published, so the arm64
path dead-ends. On intelmini that constraint disappears.

Two gcloud accounts are configured. The commands recorded in the plan use
`--account=stevespicklemire@gmail.com` explicitly, because
`spicklemire@uindy.edu` lacks permission on the trinket projects and had become
the active account mid-session.
