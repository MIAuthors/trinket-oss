# Database Leak Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop three collections from growing without bound, and fix the collection scan that makes the worst of them a latency problem as well as a storage one.

**Architecture:** Every fix is a declarative index added through the existing
`config.index` seam in `lib/models/model.js:17,97-101`, plus one Firestore
`fieldOverrides` entry. No sweeper jobs, no new runtime code, no controller
changes. Mongo's TTL monitor and Firestore's TTL policy do the deleting.

**Tech Stack:** Node/CommonJS, mongoose ^6, vitest + mongodb-memory-server
(real mongod 6.0.14), Firestore emulator for the alternate backend profile.

## Global Constraints

- Target branch: `picup/main`. **picup runs Mongo in production** — the Mongo half
  of every task is the production-critical half.
- Both database backends must keep working. `lib/db/backend-factory.js:10` defaults
  to `mongoose`; Firestore is opt-in via `config.db.backend`.
- A real mongoose `Schema` is built at `lib/models/model.js:11` **regardless of
  backend**, so schema-level index declarations are safe on both paths —
  `firestore-backend.js` reads only field paths and `ref`, ignoring index metadata.
- Alternate backend profile:
  `TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=localhost:8080 npx vitest run --fileParallelism=false`.
- **The unit tests run in the container**, which is how this repo is normally
  worked on: `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose run --rm --no-deps app npm test`.
  They need no services — `test/helpers/mongo-global.mjs` boots an in-process
  `mongod` 6.0.14 via `mongodb-memory-server`, and redis is mocked. The Docker
  *stacks* (`make mongo`, `make gcp`) run the application and are only needed for
  the end-to-end check in Task 5. Note `docker-compose.yml` pins `mongo:5` while
  the harness uses 6.0.14 — TTL semantics are identical.
- **Build the image `linux/amd64`.** picup and webapps are both `x86_64`, so amd64
  matches production; it is slower on Apple Silicon under emulation, which does
  not matter here. It also sidesteps a real trap: on arm64,
  `mongodb-memory-server` asks for `mongodb-linux-aarch64-debian11-6.0.14`, which
  MongoDB never published (403). `MONGOMS_DISTRO=ubuntu-22.04` gets past that but
  then fails on a missing `libcrypto.so.3`; `ubuntu-20.04` works. None of that is
  needed on amd64.
- **After any platform switch, drop the `node_modules` volume**
  (`docker volume rm <project>_node_modules`). Docker seeds a named volume only
  once, so a rebuilt image does not refresh it, and the stale copy fails with
  `Cannot find module @rollup/rollup-linux-x64-gnu` — an error that points at
  npm's optional-dependency bug rather than at the architecture mismatch.
- Host runs also work (`nvm use` for node 20) and are faster for a tight loop, but
  the container is the reference environment.
- `NODE_ENV=test` is set by `test/helpers/vitest-setup.cjs`, which makes
  `SomeModel.model` the raw mongoose model (`lib/models/model.js:215-217`). That is
  the seam tests use.
- Commit style: conventional commits, one commit per task.

## Measured baseline — 2026-07-27

Counts taken from all five deployed servers before planning. They set the
execution order, and two of them contradicted the original hypothesis.

**Mongo — picup production** (whole database: 10.6 MB)

| Collection | count | note |
|---|---|---|
| `sessions` | **797** | the only collection with demonstrated accumulation |
| `snippets` | 4,218 | 12 MB of legitimate content |
| `ltinonces` | **collection absent** | picup has no LTI usage at all |
| `errorevents` / `clientmetrics` / `exports` | **0** | endpoints exist, nothing calls them |

**Mongo — trial-merge on webapps:** effectively empty (386 snippets, 6 users,
0 sessions, no `ltinonces`). Runs Canvas alongside, so it is the right host for an
end-to-end LTI launch test.

**Firestore:** `ltinonces` 28 (mandi) / 65 (uindy) / 0 (trial); `sessions` 30 / 0 / 0;
`errorevents`, `clientmetrics`, `exports` all 0 everywhere.

### The sessions leak is confirmed, not inferred

picup production carries the index exactly as the code declares it:

```
{"stored":1}  expireAfterSeconds=0  partial={"ttl":{"$exists":true}}
```

All 797 documents have a `ttl` field, so every one matches that partial filter.
**494 are older than 30 days. The oldest is 2026-05-18.** `mongod` has deleted
zero. That is direct proof the index does nothing, because `stored` is a Number
and the TTL monitor only expires `Date` fields.

### What this changed

- **Sessions ships first.** It is the only leak with observed accumulation on a
  production host.
- **The nonce leak does not affect picup** — no LTI, no collection. It lands on
  **uindy**, which is Firestore and LTI-first, as classes resume. Still worth
  fixing; it is a Fall problem, not a today problem.
- **`errorevents` is not the volume leader.** An earlier draft called it
  "plausibly the largest of the four leaks." It is zero on all five servers.
  Part 3 is defensive, not urgent.
- **Nothing here is urgent.** The entire leak across the fleet is under a
  megabyte. This is pre-Fall hygiene.

### Backend naming divergence

Mongo and Firestore disagree on collection names for some models: mongoose
pluralizes properly (`ltiuseridentities`, `featuredcourses`) while
`firestore-backend.js:1134` appends a bare `s` (`ltiuseridentitys`,
`featuredcoursess`). `ltinonces`, `sessions`, and `errorevents` happen to match on
both. Anything querying across backends needs both spellings.

## Critical test-design notes

Read these before writing any test. They are not obvious and will cost an hour each.

1. **`afterEach` drops the database, and dropping a database drops its indexes.**
   `test/helpers/vitest-setup.cjs` calls `dropDatabase()` after every test and says
   so in its own comment. Any test asserting an index exists **must call
   `Model.syncIndexes()` itself first** — otherwise it passes on the first test in a
   file and fails on every one after it.
2. **TTL deletion IS testable, but only via a startup parameter.** An earlier
   draft of this plan said not to test it, on the grounds that `mongod`'s TTL
   monitor runs on a ~60 second cycle. That was wrong in a useful way:
   `test/helpers/mongo-global.mjs` now starts mongod with
   `--setParameter ttlMonitorSleepSecs=1`, and the deletion assertions complete in
   300-800ms. Setting the parameter from *inside* a test does not work — it only
   takes effect after the monitor's current sleep, leaving the first sweep ~60s
   out (measured: 59.4s).

   This matters more than it looks. Every bug in this plan is of the form "the
   index existed and did nothing," and an index-specification assertion would
   have passed against all of them. Assert the field's *type* and, at least once
   per collection, that a document actually disappears.
3. **Skip the index tests under the Firestore profile.** With
   `TEST_DB_BACKEND=firestore`, `createModel` returns a Firestore model that has no
   `syncIndexes` or `collection.indexes()`. Guard with
   `describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')`.
4. **Firestore TTL cannot be tested by vitest at all.** The emulator does not run
   TTL policies. Firestore correctness is verified by deploy output and `gcloud`,
   covered in Task 5.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `lib/models/ltiNonce.js` | modify | nonce index + TTL declaration, corrected comment |
| `lib/util/catbox-mongoose.js` | modify | add `expiresAt` Date + working TTL index |
| `lib/models/errorEvent.js` | modify | 400-day TTL added to its existing index array |
| `firestore.indexes.json` | modify | `fieldOverrides` TTL entry for `ltinonces` |
| `test/lib/models/ltiNonce.test.js` | create | nonce index assertions |
| `test/lib/models/telemetry-retention.test.js` | create | errorEvent TTL + existing-index regression guard |
| `test/lib/util/catbox-mongoose.test.js` | create | session TTL + expiry-path assertions |

## PR strategy: one PR, four commits

Ship this as a **single PR**, not three. picup already has four open PRs (#65,
#67, #68, #69, all from July 23-25) and maintainer review bandwidth is the
constraint — three more would make seven. The whole change is four small files
plus three test files, which reads as one coherent review.

Keep **one commit per task** in the order below. That preserves the revertability
that separate PRs would have given: any single part can be reverted by its commit
without touching the others. Order is sessions first (the only leak with observed
accumulation on a production host), telemetry last (zero everywhere, purely
defensive).

Suggested PR title: *fix: bound three collections that never expire*

**Note on mechanics:** `git push picup` returns 403 — the working account has read
access to `picup-physics/trinket-oss`, not write. The branch lives on
`origin` (`MIAuthors/trinket-oss`), so this must be opened as a cross-repository
PR from `MIAuthors:fix/collection-expiry` into `picup-physics:main`. Also note `origin/main`
is 33 commits behind `picup/main`; branch from `picup/main`, which is what local
`main` tracks.

---

## Part 1 — Session store (Task 1)

`lib/util/catbox-mongoose.js:19` declares a TTL index and comments it as
*"automatically delete expired sessions"*. It deletes nothing: `stored` is
`{ type: Number, default: Date.now }`, and MongoDB's TTL monitor acts only on
`Date`-typed fields, silently ignoring numeric ones.

**Design decision — add a field, do not change `stored`'s type.** Converting
`stored` to a Date would break the arithmetic at line 87
(`Date.now() - record.stored`) and change the shape returned to catbox at line
93-96. Adding a separate `expiresAt` Date leaves every existing read path
untouched.

Existing documents will lack `expiresAt` and so are never TTL-deleted. The lazy
delete at line 86-89 still collects them on read. Purging the pre-existing backlog
is an operational step, not a code change — see "Production rollout".

### Task 1: Give sessions a TTL field that actually expires

**Files:**
- Modify: `lib/util/catbox-mongoose.js:8-22` (schema + index), `:102-120` (`set`)
- Test: `test/lib/util/catbox-mongoose.test.js` (create)

**Interfaces:**
- Consumes: the catbox engine API — `set(key, value, ttl)` where `ttl` is
  milliseconds, `get(key)` returning `{item, stored, ttl}` or `null`.
- Produces: session documents gain `expiresAt: Date`. No caller changes; `stored`
  and `ttl` keep their existing types and meanings.

- [ ] **Step 1: Write the failing test**

Create `test/lib/util/catbox-mongoose.test.js`:

```js
// The session store's TTL index only works if the indexed field is a Date --
// mongod ignores numeric fields entirely. These tests pin both the index and
// the field type, because the previous version looked correct and did nothing.
const mongoose = require('mongoose');

describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('catbox-mongoose session TTL', () => {
  let engine;

  beforeEach(async () => {
    // The module exports { Engine }; start() registers the 'Session' model.
    const { Engine } = require('../../../lib/util/catbox-mongoose');
    engine = new Engine({});
    await engine.start();
    // The global afterEach drops the database, taking indexes with it.
    await mongoose.model('Session').syncIndexes();
  });

  it('declares the TTL index on a Date field, not a Number', async () => {
    const indexes = await mongoose.model('Session').collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl, 'no TTL index at all').toBeTruthy();

    const field = Object.keys(ttl.key)[0];
    const path = mongoose.model('Session').schema.path(field);
    expect(path.instance, `TTL index is on ${field}, which is a ${path.instance}`)
      .toBe('Date');
  });

  it('stamps expiresAt from the ttl when storing a session', async () => {
    const before = Date.now();
    await engine.set({ segment: 's', id: 'abc' }, { user: 1 }, 60000);

    const doc = await mongoose.model('Session').findById('s:abc').lean();
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60000);
  });

  it('still returns a live session and still drops an expired one', async () => {
    await engine.set({ segment: 's', id: 'live' }, { user: 1 }, 60000);
    const live = await engine.get({ segment: 's', id: 'live' });
    expect(live.item).toEqual({ user: 1 });

    await engine.set({ segment: 's', id: 'dead' }, { user: 2 }, 1);
    await new Promise((r) => setTimeout(r, 20));
    const dead = await engine.get({ segment: 's', id: 'dead' });
    expect(dead).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/lib/util/catbox-mongoose.test.js`

Expected: test 1 FAILS with `TTL index is on stored, which is a Number`, and
test 2 FAILS because `expiresAt` is undefined. Test 3 PASSES — it pins behaviour
that must survive the change.

- [ ] **Step 3: Add the Date field and move the index onto it**

In `lib/util/catbox-mongoose.js`, change the schema and index:

```js
const sessionSchema = new mongoose.Schema({
  _id: String,           // segment:id composite key
  value: mongoose.Schema.Types.Mixed,
  stored: { type: Number, default: Date.now },   // ms epoch; get() does arithmetic on it
  ttl: Number,
  expiresAt: Date        // stored + ttl, as a Date -- mongod only expires Date fields
}, {
  collection: 'sessions',
  timestamps: false
});

// TTL index. This MUST be on a Date field: mongod's TTL monitor silently ignores
// numeric fields, which is why the previous index on `stored` (a Number) never
// deleted anything despite looking correct.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```

- [ ] **Step 4: Populate the field on write**

In the same file's `set(key, value, ttl)` method, add `expiresAt` alongside the
existing fields it writes (around line 112-117):

```js
        ttl: ttl,
        expiresAt: new Date(Date.now() + ttl)
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/lib/util/catbox-mongoose.test.js`
Expected: 3 passed.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: no new failures. Session handling is exercised broadly by
`test/lib/api/*.test.js`, so this is the real regression gate for this task.

- [ ] **Step 7: Commit**

```bash
git add lib/util/catbox-mongoose.js test/lib/util/catbox-mongoose.test.js
git commit -m "fix: make the session TTL index actually expire sessions

The index was declared on `stored`, a Number. mongod's TTL monitor only
acts on Date fields and ignores numeric ones, so sessions accumulated
permanently -- the lazy delete in get() only collects sessions someone
comes back and reads.

Adds an expiresAt Date rather than retyping `stored`, which get() does
arithmetic on and returns to catbox unchanged."
```

---

## Part 2 — LTI nonces (Tasks 2-3)

Two bugs in one collection: it grows forever, and `findByNonce` scans it on every
launch because `nonce` has no index. Fixing both together is smaller than fixing
either alone.

### Task 2: Index and expire LTI nonces

**Files:**
- Modify: `lib/models/ltiNonce.js:1-20`
- Test: `test/lib/models/ltiNonce.test.js` (create)

**Interfaces:**
- Consumes: `model.create(name, config)` from `lib/models/model.js`, which accepts a
  `config.index` array of `[keySpec, optionsSpec]` pairs and applies each via
  `schema.index(...)`.
- Produces: no new exported symbols. `LtiNonce.findByNonce(nonce, cb)` keeps its
  existing signature and behaviour.

- [ ] **Step 1: Write the failing test**

Create `test/lib/models/ltiNonce.test.js`:

```js
// Index declarations on the LTI nonce collection. Mongo-only: the Firestore
// backend has no syncIndexes/collection APIs, and Firestore single-field
// indexes everything automatically, so neither assertion applies there.
const LtiNonce = require('../../../lib/models/ltiNonce');

describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('LtiNonce indexes', () => {
  beforeEach(async () => {
    // The global afterEach drops the database, and that drops indexes with it.
    // Rebuild from the schema so these assertions see a real index set.
    await LtiNonce.model.syncIndexes();
  });

  it('declares a TTL index on expiresAt', async () => {
    const indexes = await LtiNonce.model.collection.indexes();
    const ttl = indexes.find((i) => i.key && i.key.expiresAt === 1);
    expect(ttl, 'no index on expiresAt').toBeTruthy();
    expect(ttl.expireAfterSeconds).toBe(0);
  });

  it('indexes nonce so findByNonce is not a collection scan', async () => {
    const indexes = await LtiNonce.model.collection.indexes();
    expect(indexes.some((i) => i.key && i.key.nonce === 1)).toBe(true);
  });

  it('still finds a recorded nonce by value', async () => {
    await new LtiNonce({ nonce: 'abc123', expiresAt: new Date(Date.now() + 600000) }).save();
    const found = await LtiNonce.findByNonce('abc123');
    expect(found).toBeTruthy();
    expect(found.nonce).toBe('abc123');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/lib/models/ltiNonce.test.js`

Expected: the first two tests FAIL — `no index on expiresAt`, and the `nonce`
assertion returns `false`. The third test PASSES already (it documents behaviour
that must not regress).

- [ ] **Step 3: Add the index declarations**

In `lib/models/ltiNonce.js`, replace the schema and the `model.create` call:

```js
// LTI launch nonce — replay protection only (LTI-SPEC §10). Each consumed launch nonce is
// recorded until it expires. Cleanup is declarative and per-backend: on Mongo the TTL index
// below; on Firestore the `ltinonces` fieldOverride in firestore.indexes.json. Neither is
// automatic — both had to be declared, and before they were, this collection grew forever.
// Written/read through the ltiNonceStore seam (lib/util/ltiNonceStore.js).
var model = require('./model');

var schema = {
  nonce     : { type: String, required: true, index: true },  // findByNonce runs per launch
  expiresAt : { type: Date,   required: true }                // TTL field (see index below)
};

function findByNonce(nonce, cb) {
  return this.model.findOne({ nonce: nonce }, cb);
}

var LtiNonce = model.create('LtiNonce', {
  schema: schema,
  // expireAfterSeconds: 0 means "delete when the date in this field has passed",
  // not "delete immediately" — the field value IS the expiry time.
  index: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
  classMethods: { findByNonce: findByNonce }
}).publicModel;

module.exports = LtiNonce;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/lib/models/ltiNonce.test.js`
Expected: 3 passed.

- [ ] **Step 5: Confirm the whole suite still passes on both backends**

Run: `npm test`
Expected: no new failures against the pre-change baseline.

Run: `TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=localhost:8080 npx vitest run --fileParallelism=false`
Expected: the new file reports as skipped; no new failures. This proves the schema
change is inert on the Firestore path.

- [ ] **Step 6: Commit**

```bash
git add lib/models/ltiNonce.js test/lib/models/ltiNonce.test.js
git commit -m "fix: index and expire LTI nonces

findByNonce ran on every LTI launch against an unindexed field, so each
launch scanned a collection that nothing ever pruned. Adds the missing
index on nonce and a TTL index on expiresAt.

The model comment claimed a Firestore TTL policy auto-deleted old rows.
No such policy was ever configured on any database, and nothing in the
code deletes a nonce, so every launch since LTI shipped leaked one row."
```

### Task 3: Declare the Firestore TTL policy

**Files:**
- Modify: `firestore.indexes.json`

**Interfaces:**
- Consumes: nothing from Task 2 at runtime; same collection, other backend.
- Produces: a `fieldOverrides` entry that `deploy-cloudrun.sh:234-239` applies on
  every deploy via `firebase deploy --only firestore:indexes,firestore:rules`.

- [ ] **Step 1: Add the field override**

`firestore.indexes.json` already has a `fieldOverrides` key with an empty array.
Replace it with:

```json
  "fieldOverrides": [
    {
      "collectionGroup": "ltinonces",
      "fieldPath": "expiresAt",
      "ttl": true,
      "indexes": [
        { "order": "ASCENDING",  "queryScope": "COLLECTION" },
        { "order": "DESCENDING", "queryScope": "COLLECTION" }
      ]
    }
  ]
```

The two `indexes` entries preserve Firestore's default single-field indexing.
Omitting them (`"indexes": []`) would *disable* it — a separate change, not part of
this fix.

- [ ] **Step 2: Validate the file parses and keeps its existing indexes**

Run: `node -e "const d=require('./firestore.indexes.json'); console.log('indexes',d.indexes.length,'overrides',d.fieldOverrides.length)"`
Expected: `indexes 8 overrides 1`

- [ ] **Step 3: Check the local firebase-tools version first**

Run: `firebase --version`

This matters. On firebase-tools 13.22.1, when field overrides exist in a project
but not in the file, `lib/firestore/api.js:84-101` logs *"To delete them, run this
command with the --force flag"* and then calls `confirm()` anyway — which **throws**
under `--non-interactive` without `--force`. `deploy-cloudrun.sh:234-239` uses
exactly that flag combination. Other CLI versions may warn and continue instead.
Record the version observed; it decides how Step 4 is read.

- [ ] **Step 4: Dry-run the deploy against one Firestore project**

Run: `firebase deploy --only firestore:indexes --project=trinket-merge-test --account "$(gcloud config get-value account)" --dry-run`

Expected: no error. If the CLI reports field overrides present in the project but
absent from the file, **stop** — something enabled a TTL out of band, and per
Step 3 that combination can fail the deploy rather than continue.

- [ ] **Step 5: Commit**

```bash
git add firestore.indexes.json
git commit -m "fix: declare the ltinonces TTL policy for Firestore deploys

Keeps cleanup in the deploy recipe rather than as a hand-run command, so
new deploys get it automatically and a one-off gcloud change cannot drift
from the declared config."
```

---

## Part 3 — Telemetry retention (Task 4)

`errorevents` is written on every client error (`lib/controllers/trinket.js:1027`)
with no expiry field and no cleanup path anywhere. The model's own header describes
recording every `encountered → repeated → resolved` error cycle per coding session,
so it would grow fast under real student traffic.

**It is currently zero on all five servers.** This PR is therefore defensive —
a bound placed before the traffic arrives, not a response to observed growth. Ship
it last, and treat a non-zero count here as the signal to revisit the 400-day
number with real data.

No new field is needed: `lib/models/plugins/timestamps.js` adds
`created: { type: Date, default: Date.now }`, applied by `model.js:41-43` to every
model that does not set `timestamps: false`. `errorEvent` does not, so `created`
exists and a TTL index on it applies to existing documents immediately, with no
backfill.

**Retention: 400 days** (34,560,000 seconds) — a full academic year plus margin, so
year-over-year and cross-cohort comparison still work.

**`clientMetric` is deliberately excluded** — it is a different problem wearing the
same clothes. See "Deliberately out of scope".

### Task 4: Expire error telemetry after 400 days

**Files:**
- Modify: `lib/models/errorEvent.js` (the `model.create` call at the bottom)
- Test: `test/lib/models/telemetry-retention.test.js` (create)

**Interfaces:**
- Consumes: the `config.index` seam, same as Task 1.
- Produces: no new exported symbols; both models keep their existing APIs.

- [ ] **Step 1: Write the failing test**

Create `test/lib/models/telemetry-retention.test.js`:

```js
// errorevents is append-per-error with no cleanup path; this index is the only
// thing bounding it. 400 days keeps a full academic year for year-over-year
// comparison while still bounding growth.
const ErrorEvent = require('../../../lib/models/errorEvent');

const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;   // 34,560,000 seconds

describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('telemetry retention', () => {
  beforeEach(async () => {
    // The global afterEach drops the database, taking indexes with it.
    await ErrorEvent.model.syncIndexes();
  });

  it('expires error events 400 days after created', async () => {
    const indexes = await ErrorEvent.model.collection.indexes();
    const ttl = indexes.find((i) => i.key && i.key.created === 1);
    expect(ttl, 'no TTL index on created').toBeTruthy();
    expect(ttl.expireAfterSeconds).toBe(FOUR_HUNDRED_DAYS);
  });

  it('keeps the existing compound query index', async () => {
    // errorEvent already declared an index before this change; the TTL entry
    // must extend that array, not replace it.
    const indexes = await ErrorEvent.model.collection.indexes();
    const compound = indexes.find((i) => i.key && i.key.lang === 1 && i.key.session === 1);
    expect(compound, 'the pre-existing lang/state/type/session index was dropped').toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/lib/models/telemetry-retention.test.js`
Expected: the TTL test FAILS with `no TTL index on created`. The compound-index
test PASSES already — it is a regression guard for Step 3.

- [ ] **Step 3: Extend errorEvent's existing index array**

`lib/models/errorEvent.js` **already passes an `index` key**. Add the TTL pair to
that array rather than introducing a new key. The whole call becomes:

```js
module.exports = model.create('ErrorEvent', {
  schema : schema,
  index: [
    [{ lang: 1, state: 1, type: 1, session: 1 }],
    // Append-per-error with no cleanup path. 400 days keeps a full academic year
    // (year-over-year comparison) while bounding growth. `created` comes from the
    // timestamps plugin, so this applies to existing documents too.
    [{ created: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 }]
  ]
}).publicModel;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/lib/models/telemetry-retention.test.js`
Expected: 2 passed.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add lib/models/errorEvent.js test/lib/models/telemetry-retention.test.js
git commit -m "fix: expire error telemetry after 400 days

errorevents is written per client error with no expiry field and no
cleanup anywhere -- on a deployment with real student traffic, the
largest uncapped collection in the schema.

Uses \`created\` from the timestamps plugin, so no new field and no
backfill; the index applies to existing documents on the next boot."
```

---

## Task 5: Verify on the Mongo test server

**Files:** none — this is verification, not code.

Do this on trial-merge (webapps) before any of these reach production. The
interesting behaviour only appears against a pre-existing backlog, which the test
suite cannot reproduce.

Reach the database with:
`ssh webapps 'docker exec mongodb mongo trinket --quiet --eval "<js>"'`

**Important:** as of the baseline, trial-merge is nearly empty — 0 sessions, no
`ltinonces` collection, and Canvas sitting alongside but unused for launches. The
verification below therefore requires **generating the traffic first**: log in to
create sessions, and run LTI launches through the co-located Canvas to create
nonces. Verifying against empty collections proves nothing.

- [ ] **Step 1: Generate traffic, then record the baseline**

Log in a few times, and run at least two LTI launches from the Canvas instance on
the same host. Then:

```
db.sessions.estimatedDocumentCount()
db.ltinonces.estimatedDocumentCount()
db.getCollectionNames()
```

Use `estimatedDocumentCount()` — it reads collection metadata, where
`countDocuments()` scans. Irrelevant at this size, but it is the habit that keeps
the same commands safe to paste against picup production.

Confirm the collection names — mongoose pluralizes properly
(`ltiuseridentities`), the Firestore backend does not (`ltiuseridentitys`). The
three collections here happen to match on both backends; do not assume that of
others.

- [ ] **Step 2: Deploy the branch and restart**

`config/db.js:44` calls `mongoose.connect()` with no options, and mongoose ^6
defaults `autoIndex` to `true`, so the indexes build at boot with no migration
step.

- [ ] **Step 3: Confirm the indexes exist**

```
db.sessions.getIndexes()       // expect expiresAt_1, and NO index on stored
db.ltinonces.getIndexes()      // expect nonce_1 and expiresAt_1 with expireAfterSeconds: 0
db.errorevents.getIndexes()    // expect created_1 with expireAfterSeconds: 34560000
```

For sessions, the pre-change shape to compare against — captured from picup
production — is:

```
{"stored":1}  expireAfterSeconds=0  partial={"ttl":{"$exists":true}}
```

That index must be **gone**, replaced by one on `expiresAt`.

- [ ] **Step 4: Confirm new writes stamp expiresAt**

```
db.sessions.findOne({}, {stored:1, ttl:1, expiresAt:1})
```

Expect `expiresAt` present and of type Date. This is the single assertion that
distinguishes a working TTL from the broken one — `stored` being a Number is
exactly why the old index never fired.

- [ ] **Step 5: Confirm the backlog drains**

Wait ~2 minutes (the TTL monitor runs on a ~60s cycle) and re-count. `ltinonces`
should fall to roughly the number of launches in the last 10 minutes. Sessions
created *before* the deploy will **not** drop — they have no `expiresAt`. That is
expected; see "Production rollout".

- [ ] **Step 6: Confirm replay protection still works**

Perform a real LTI launch through Canvas, then replay the same `id_token`. It must
still be rejected. This is the one behaviour the TTL change could plausibly affect,
and it is cheaper to verify directly than to reason about.

- [ ] **Step 7: Confirm launch latency improved**

```
db.ltinonces.find({nonce: "<any recorded value>"}).explain("executionStats")
```

Expect `IXSCAN`, not `COLLSCAN`. At trial-merge's size the timing difference is
invisible; the plan stage that matters is the query plan, not the milliseconds.

---

## Production rollout notes

**Backlog size is a non-issue — measured, not assumed.** The general risk is that
enabling a TTL index on a large backlog makes `mongod` delete it in 60-second
batches, generating sustained delete load and oplog churn on a replica set. That
does not apply here: at baseline picup production holds 797 sessions, no
`ltinonces` collection, and zero `errorevents`, in a 10.6 MB database. Nothing to
pre-trim. Re-check with `estimatedDocumentCount()` before deploying if significant
time has passed since 2026-07-27.

**Sessions need a one-off purge.** Pre-existing session documents have no
`expiresAt` and will never be TTL-collected — 494 of picup's 797 are already
older than 30 days, the oldest from 2026-05-18. After Part 1 is deployed and
verified:

```
db.sessions.deleteMany({ expiresAt: { $exists: false },
                         stored: { $lt: Date.now() - 30*24*60*60*1000 } })
```

Only run this once new writes are confirmed to be stamping `expiresAt` — otherwise
it deletes live sessions and logs users out.

**Firestore deploys** pick up the `ltinonces` policy on the next
`deploy-cloudrun.sh` run. To apply it immediately without a redeploy:

```
gcloud firestore fields ttls update expiresAt \
  --collection-group=ltinonces --enable-ttl --project=<project>
```

This now matches the declared override, so no drift either way.

---

## Deliberately out of scope

**Expired export records.** `lib/models/export.js` sets `expiresAt` from
`EXPORT_EXPIRY_DAYS = 3` and nothing ever reads it, so export records accumulate.
This is *not* an index fix: each record points at a generated object in the
`exports` bucket (`lib/workers/exports.js:388`), so TTL-deleting the record alone
would orphan the file and leak storage instead of documents. It needs a sweeper
that deletes both, with its own failure handling — a separate spec, not a task
here.

**`clientMetric` retention.** It looks like the twin of `errorEvent` and is not.
Three differences make it a separate problem needing its own decision:

1. It sets `timestamps: false`, so **it has no `created` field** — `model.js:41-43`
   only applies the timestamps plugin when `timestamps !== false`. The TTL field
   would have to be `timestamp_minute`.
2. It is **not append-per-event**. `addMetric` upserts one document per clock
   minute and `$push`es each event into a `values` array, so the document count is
   bounded at 1,440/day regardless of traffic.
3. The real risk is therefore **document growth, not document count**: under heavy
   load a single minute's `values` array grows toward MongoDB's 16 MB per-document
   limit, at which point writes for that minute start failing. A TTL does nothing
   about that.

And the mechanical fix is not mechanical: `timestamp_minute` already carries
`unique: true`, which creates an index. MongoDB rejects a second index with the
same key pattern and different options, so adding TTL means folding
`expireAfterSeconds` into the existing unique index — which makes `syncIndexes()`
drop and rebuild a unique index on a large production collection. That deserves its
own review, not a footnote in a three-PR change.

**Nonce uniqueness.** `lib/util/ltiNonceStore.js:8` documents a known TOCTOU race
and suggests a unique index as the hardening. A `unique: true` index would close
it, but converts a replay from a `false` return into an E11000 error the store must
catch and translate. That is a behaviour change with its own test surface; bundling
it would muddy three otherwise purely additive PRs. Worth a follow-up issue.

**`ltiregistrationtokens`.** Has an unread `expiresAt`, but is bounded by the
number of LMS registrations — a handful per deploy. Records are also expected to
outlive expiry so `isUsable()` can explain *why* a registration failed
(`lib/controllers/admin.js:44`). Leave it alone.
