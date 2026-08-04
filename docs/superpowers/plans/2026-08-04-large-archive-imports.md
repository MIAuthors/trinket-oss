# Large Archive Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let course archives larger than Cloud Run's 32 MiB ingress cap import successfully by uploading them directly to storage via a signed URL, then importing server-side from that object — with a per-deploy opt-out.

**Architecture:** A new signed-URL upload path runs *alongside* the existing multipart `POST /api/imports/course`. The browser asks the app for a signed PUT URL, uploads the zip straight to GCS/S3 (bypassing Cloud Run), then calls a new `from-storage` route that downloads the object and feeds it into the **existing** import pipeline. Small files keep the direct POST unchanged. The whole large path is gated by one config-backed predicate so a deploy can disable it.

**Tech Stack:** Node (ES5-style `var`/callbacks+promises, matching each file), Hapi via the `routeParser` shim (`request.success`/`request.fail`, `@hapi/boom`), `node-config` (`config/default.yaml`), storage abstraction in `lib/util/storage-backend*.js` (GCS `@google-cloud/storage`, S3/garage `aws-sdk` v2), Vitest tests (mongodb-memory-server; `TEST_S3=garage` real-S3 profile), nunjucks views.

Design spec: `docs/superpowers/specs/2026-08-03-large-archive-imports-design.md`.

## Global Constraints

- **Additive, non-disruptive:** the existing multipart `POST /api/imports/course` and its behavior for small imports must be **byte-for-byte unchanged** (it and the new route share one extracted pipeline function). Upstreamable to picup.
- **One opt-out authority:** `FileUtil.isSignedUploadAvailable()` is the single predicate. Both new routes gate on it (501 when false) and the client reads the config hint but treats a 501 as "fall back to direct POST." `imports.largeUpload.enabled` defaults **true**.
- **Config keys (exact):** `imports.largeUpload.enabled` (bool), `imports.largeUpload.thresholdBytes` (int, 26214400), `imports.largeUpload.maxArchiveBytes` (int, 104857600).
- **Temp object key shape (exact):** `imports/tmp/{userId}/{uuid}.zip` in the **materials** bucket (`config.aws.buckets.materials.name`). No new bucket.
- **Server is the size authority:** enforce `maxArchiveBytes` on the downloaded object (413), not on the signed PUT.
- **Ownership:** `from-storage` must verify the `{userId}` in the key equals `request.user.id` (403 otherwise).
- **Match each file's existing style** (callbacks in `storage-backend*`/`file.js`, promises in `imports.js`). Use `@hapi/boom` for error responses (`Boom.notImplemented`, `Boom.forbidden`, `Boom.entityTooLarge`).
- **Tests on intelmini:** temporarily mask `config/local.yaml` (it forces `db.backend: firestore` and crashes the mongoose profile), run `npx vitest run <file>`, then restore it. S3 integration needs `TEST_S3=garage`.

---

## File Structure

- `config/default.yaml` — **modify**: add top-level `imports.largeUpload` block.
- `lib/util/storage-backend-gcs.js` — **modify**: add `signUploadUrl`.
- `lib/util/storage-backend-s3.js` — **modify**: add `signUploadUrl`.
- `lib/util/file.js` — **modify**: add `isSignedUploadAvailable`, `signImportUploadUrl`, `readImportObjectAsBuffer`, `deleteImportObject`.
- `lib/controllers/imports.js` — **modify**: extract `runCourseImport(zipBuffer, opts)`; add `getImportUploadUrl` and `importCourseFromStorage`; export both.
- `config/api_routes.js` — **modify**: add `POST /api/imports/upload-url` and `POST /api/imports/course/from-storage`.
- `lib/views/base.html` — **modify**: expose `largeUpload` to the client alongside `assetsEnabled` (base.html:84).
- `lib/views/users/includes/import.html` — **modify**: size-branch `submitCourse`, add signed-URL flow with progress, surface all errors.
- `docs/deploy/large-archive-imports-infra.md` — **create**: operator runbook (IAM self-sign binding + bucket lifecycle rule).
- Tests: `test/lib/util/file.test.js` (or existing), `test/lib/util/storage-backend.test.js`, `test/lib/api/imports-large.test.js` (new).

---

## Task 1: Config + availability predicate

**Files:**
- Modify: `config/default.yaml` (add `imports.largeUpload`)
- Modify: `lib/util/file.js` (add `isSignedUploadAvailable`)
- Test: `test/lib/util/file-availability.test.js` (create)

**Interfaces:**
- Produces: `FileUtil.isSignedUploadAvailable() -> boolean`. True iff `config.imports.largeUpload.enabled` **and** `config.storage.backend` is `'gcs'` or `'s3'`.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/util/file-availability.test.js
const config = require('config');

describe('FileUtil.isSignedUploadAvailable', () => {
  let FileUtil, orig;
  beforeEach(() => {
    FileUtil = require('../../../lib/util/file');
    orig = { imports: config.imports, backend: config.storage && config.storage.backend };
  });
  afterEach(() => {
    config.imports = orig.imports;
    if (config.storage) config.storage.backend = orig.backend;
  });

  it('is true when enabled and backend is s3', () => {
    config.imports = { largeUpload: { enabled: true } };
    config.storage.backend = 's3';
    expect(FileUtil.isSignedUploadAvailable()).toBe(true);
  });
  it('is true when enabled and backend is gcs', () => {
    config.imports = { largeUpload: { enabled: true } };
    config.storage.backend = 'gcs';
    expect(FileUtil.isSignedUploadAvailable()).toBe(true);
  });
  it('is false when enabled is false even with storage configured', () => {
    config.imports = { largeUpload: { enabled: false } };
    config.storage.backend = 's3';
    expect(FileUtil.isSignedUploadAvailable()).toBe(false);
  });
  it('is false when the imports config is absent', () => {
    config.imports = undefined;
    config.storage.backend = 's3';
    expect(FileUtil.isSignedUploadAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`isSignedUploadAvailable is not a function`)

Run (from repo root, intelmini): `mv config/local.yaml config/local.yaml.masked; npx vitest run test/lib/util/file-availability.test.js; mv -f config/local.yaml.masked config/local.yaml`

- [ ] **Step 3: Add the config block** to `config/default.yaml` (top level, e.g. after the `storage:` block at the top):

```yaml
imports:
  largeUpload:
    enabled: true                 # per-deploy opt-out; false = direct POST only (small files)
    thresholdBytes: 26214400      # 25 MiB — client switch point (< 32 MiB ingress cap)
    maxArchiveBytes: 104857600    # 100 MiB — server ceiling enforced on from-storage
```

- [ ] **Step 4: Implement the predicate** in `lib/util/file.js` (add inside `FileUtil`, near the other `this.` methods):

```js
  this.isSignedUploadAvailable = function() {
    var lu = config.imports && config.imports.largeUpload;
    if (!lu || !lu.enabled) return false;
    var b = config.storage && config.storage.backend;
    return b === 'gcs' || b === 's3';
  };
```

- [ ] **Step 5: Run tests, expect PASS**

- [ ] **Step 6: Commit** — `git add config/default.yaml lib/util/file.js test/lib/util/file-availability.test.js && git commit -m "feat(imports): largeUpload config + isSignedUploadAvailable predicate"`

---

## Task 2: Storage signing + import-object helpers

**Files:**
- Modify: `lib/util/storage-backend-gcs.js`, `lib/util/storage-backend-s3.js` (add `signUploadUrl`)
- Modify: `lib/util/file.js` (add `signImportUploadUrl`, `readImportObjectAsBuffer`, `deleteImportObject`)
- Test: `test/lib/util/storage-signing.test.js` (create)

**Interfaces:**
- Consumes: the storage backend module's existing `upload`/`downloadBuffer`/`deleteFile`.
- Produces:
  - backend `signUploadUrl(bucketName, key, contentType, ttlSeconds) -> Promise<string>` (a signed PUT URL)
  - `FileUtil.signImportUploadUrl(key, contentType, ttlSeconds) -> Promise<string>`
  - `FileUtil.readImportObjectAsBuffer(key) -> Promise<Buffer>`
  - `FileUtil.deleteImportObject(key, cb?)` (best-effort)
  - All three scope to `config.aws.buckets.materials.name`.

- [ ] **Step 1: Write the failing test** (shape assertions for both backends + garage round-trip):

```js
// test/lib/util/storage-signing.test.js
describe('storage signUploadUrl', () => {
  it('s3 backend returns a presigned PUT url string', async () => {
    const s3 = require('../../../lib/util/storage-backend-s3');
    const url = await s3.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(typeof url).toBe('string');
    expect(url).toMatch(/some-bucket/);
    expect(url).toMatch(/imports\/tmp\/u1\/abc\.zip/);
    expect(url).toMatch(/X-Amz-Expires=900|Expires=/);   // presigned params present
  });

  it.skipIf(!process.env.GCS_TEST)('gcs backend returns a v4 write url', async () => {
    const gcs = require('../../../lib/util/storage-backend-gcs');
    const url = await gcs.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(typeof url).toBe('string');
    expect(url).toMatch(/X-Goog-Algorithm|GoogleAccessId/);
  });

  it.skipIf(process.env.TEST_S3 !== 'garage')('FileUtil read/delete round-trip against garage', async () => {
    const FileUtil = require('../../../lib/util/file');
    const backend = require('../../../lib/util/storage-backend');
    const config = require('config');
    const key = 'imports/tmp/u1/roundtrip.zip';
    await new Promise((res, rej) => backend.upload(config.aws.buckets.materials.name, key, Buffer.from('zipbytes'), 'application/zip', (e) => e ? rej(e) : res()));
    const buf = await FileUtil.readImportObjectAsBuffer(key);
    expect(buf.toString()).toBe('zipbytes');
    await new Promise((res) => FileUtil.deleteImportObject(key, res));
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`signUploadUrl is not a function`).

- [ ] **Step 3: Implement S3 signing** in `lib/util/storage-backend-s3.js` (aws-sdk v2 `getSignedUrl('putObject')` is synchronous — same call already used in `lib/controllers/users.js:1194` with `'getObject'`; wrap in a resolved Promise):

```js
  signUploadUrl: function(bucketName, key, contentType, ttlSeconds) {
    var client = new aws.S3();
    return Promise.resolve(client.getSignedUrl('putObject', {
      Bucket: bucketName, Key: key, Expires: ttlSeconds, ContentType: contentType
    }));
  },
```

- [ ] **Step 4: Implement GCS signing** in `lib/util/storage-backend-gcs.js`:

```js
  signUploadUrl: function(bucketName, key, contentType, ttlSeconds) {
    return getStorage().bucket(bucketName).file(key).getSignedUrl({
      version: 'v4', action: 'write',
      expires: Date.now() + (ttlSeconds * 1000),
      contentType: contentType
    }).then(function(data) { return data[0]; });
  }
```

- [ ] **Step 5: Add the FileUtil wrappers** in `lib/util/file.js`:

```js
  this.signImportUploadUrl = function(key, contentType, ttlSeconds) {
    return backend.signUploadUrl(config.aws.buckets.materials.name, key, contentType, ttlSeconds);
  };
  this.readImportObjectAsBuffer = function(key) {
    return backend.downloadBuffer(config.aws.buckets.materials.name, key);
  };
  this.deleteImportObject = function(key, cb) {
    backend.deleteFile(config.aws.buckets.materials.name, key, cb || function() {});
  };
```

- [ ] **Step 6: Run tests** (S3 shape always; garage round-trip with `TEST_S3=garage npx vitest run test/lib/util/storage-signing.test.js`), expect PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(imports): signed PUT URLs (gcs+s3) and materials import-object helpers"`

---

## Task 3: Extract the shared course-import pipeline

**Files:**
- Modify: `lib/controllers/imports.js` (extract `runCourseImport`, rewire `importCourse`)
- Test: reuse the existing course-import integration test (find it via `grep -rln "imports/course\|importCourse" test/`); if none covers the happy path, add one that imports a small fixture zip and asserts a course is created.

**Interfaces:**
- Produces: `runCourseImport(zipBuffer, { user, name, force }) -> Promise<data>` where `data` is the response object: `{status:'ok', courseId, slug, ownerSlug, url, warnings?}` **or** `{status:'missing_refs', missing, message}`. Throws (Boom or Error) on failure. Does **not** call `request.success`/`request.fail`.

- [ ] **Step 1: Characterize current behavior** — run the existing import test(s) green first so the refactor has a baseline. If absent, write one:

```js
// asserts the direct route still works after refactor — happy path
// (use an existing fixture zip under test/fixtures if present; otherwise build a
//  minimal course zip in-test with jszip)
```

- [ ] **Step 2: Extract `runCourseImport`** in `lib/controllers/imports.js` — move the post-`JSZip.loadAsync` body of `importCourse` (lines ~352–392) into a standalone function that **returns** the data object instead of calling `request.success`:

```js
function runCourseImport(zipBuffer, opts) {
  var user = opts.user, courseName = opts.name, force = opts.force || false;
  var courseZip, globalSettings;
  return JSZip.loadAsync(zipBuffer)
    .then(function(zip) {
      courseZip = zip;
      return autoImportBundledTrinkets(zip, user).then(function() { return parseCourseZip(zip); });
    })
    .then(function(parsed) {
      globalSettings = parsed.globalSettings;
      return resolveAllRefs(parsed.chapters, user);
    })
    .then(function(result) {
      var chapters = result.chapters, missing = result.missing, legacyToTrinket = result.legacyToTrinket;
      if (missing.length && !force) {
        return { status: 'missing_refs', missing: missing,
          message: missing.length + ' trinket(s) not yet imported. Import trinkets first, or re-submit with force=true to leave old URLs intact.' };
      }
      var warnings = [];
      return createCourseFromChapters(chapters, courseName, user, courseZip, legacyToTrinket, warnings, globalSettings)
        .then(function(course) {
          var data = { status: 'ok', courseId: course.id, slug: course.slug,
            ownerSlug: user.username, url: '/' + user.username + '/courses/' + course.slug };
          if (warnings.length) data.warnings = warnings;
          return data;
        });
    });
}
```

- [ ] **Step 3: Rewire `importCourse`** to use it (behavior identical):

```js
function importCourse(request, reply) {
  return readUploadedFile(request.payload.file)
    .then(function(buf) {
      return runCourseImport(buf, { user: request.user, name: request.payload.name, force: request.payload.force });
    })
    .then(function(data) { return request.success({ data: data }); })
    .catch(function(err) {
      if (err.isBoom) return request.fail(err);
      console.error('Course import error:', err);
      return request.fail({ error: err.message });
    });
}
```

- [ ] **Step 4: Run the import test(s), expect PASS** (no behavior change). Run on **both** profiles: mongoose (default) and `TEST_DB_BACKEND=firestore`.

- [ ] **Step 5: Commit** — `git commit -m "refactor(imports): extract runCourseImport shared by both import routes"`

---

## Task 4: `upload-url` route + handler

**Files:**
- Modify: `config/api_routes.js` (add route)
- Modify: `lib/controllers/imports.js` (add `getImportUploadUrl`, export)
- Test: `test/lib/api/imports-large.test.js` (create; the upload-url cases)

**Interfaces:**
- Consumes: `FileUtil.isSignedUploadAvailable`, `FileUtil.signImportUploadUrl`, `crypto.randomUUID`.
- Produces: `POST /api/imports/upload-url` → `200 { data: { url, key, expiresAt } }`, or `501` when unavailable. `key` = `imports/tmp/{user.id}/{uuid}.zip`.

- [ ] **Step 1: Write failing tests** — use the project's existing API test harness (find a sibling in `test/lib/api/` and mirror its app-injection + auth setup). Cases:
  - authorized user → 200, `data.key` matches `^imports/tmp/<userId>/[A-Za-z0-9-]+\.zip$`, `data.url` is a string, `data.expiresAt` parses as a future date;
  - with `config.imports.largeUpload.enabled = false` → 501.

- [ ] **Step 2: Run, expect FAIL** (404 — route absent).

- [ ] **Step 3: Add the handler** in `lib/controllers/imports.js`:

```js
function getImportUploadUrl(request, reply) {
  if (!FileUtil.isSignedUploadAvailable()) {
    return request.fail(Boom.notImplemented('large upload not available'));
  }
  var ttl = 900; // 15 min
  var key = 'imports/tmp/' + request.user.id + '/' + crypto.randomUUID() + '.zip';
  return FileUtil.signImportUploadUrl(key, 'application/zip', ttl)
    .then(function(url) {
      return request.success({ data: { url: url, key: key, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } });
    })
    .catch(function(err) { return request.fail({ error: err.message }); });
}
```

- [ ] **Step 4: Export it** — add `getImportUploadUrl : getImportUploadUrl` to `module.exports`.

- [ ] **Step 5: Add the route** in `config/api_routes.js` (inside the imports routes array, after the `POST /api/imports/course` object at ~line 1508):

```js
  ,{
    route : 'POST /api/imports/upload-url imports.getImportUploadUrl',
    config : {
      auth: 'session',
      pre : ['canCreateCourse(user)']
    }
  }
```

- [ ] **Step 6: Run tests, expect PASS**

- [ ] **Step 7: Commit** — `git commit -m "feat(imports): POST /api/imports/upload-url signed-URL minting"`

---

## Task 5: `from-storage` route + handler

**Files:**
- Modify: `config/api_routes.js` (add route)
- Modify: `lib/controllers/imports.js` (add `importCourseFromStorage`, export)
- Test: `test/lib/api/imports-large.test.js` (add the from-storage cases)

**Interfaces:**
- Consumes: `FileUtil.isSignedUploadAvailable`, `FileUtil.readImportObjectAsBuffer`, `FileUtil.deleteImportObject`, `runCourseImport`, `config.imports.largeUpload.maxArchiveBytes`.
- Produces: `POST /api/imports/course/from-storage` with JSON `{ key, name?, force? }` → same `{ data }` shape as `importCourse`. 501 unavailable, 403 wrong owner, 413 oversize. Deletes the temp object in all outcomes.

- [ ] **Step 1: Write failing tests**:
  - **ownership:** a `key` whose userId segment ≠ the caller → 403;
  - **oversize:** seed a garage object larger than a temporarily-lowered `maxArchiveBytes` → 413 (`TEST_S3=garage`);
  - **happy path:** seed a valid small course zip into garage at `imports/tmp/<userId>/<uuid>.zip`, POST → `data.status === 'ok'`, course exists, and the temp object is gone afterward;
  - **opt-out:** `enabled=false` → 501.

- [ ] **Step 2: Run, expect FAIL** (404).

- [ ] **Step 3: Add the handler** in `lib/controllers/imports.js`:

```js
function importCourseFromStorage(request, reply) {
  if (!FileUtil.isSignedUploadAvailable()) {
    return request.fail(Boom.notImplemented('large upload not available'));
  }
  var user = request.user;
  var key  = request.payload.key;
  var prefix = 'imports/tmp/' + user.id + '/';
  if (typeof key !== 'string' || key.indexOf(prefix) !== 0 || key.indexOf('..') !== -1) {
    return request.fail(Boom.forbidden('not your upload'));
  }
  var maxBytes = (config.imports && config.imports.largeUpload && config.imports.largeUpload.maxArchiveBytes) || 104857600;
  var cleanup = function() { try { FileUtil.deleteImportObject(key); } catch (e) {} };

  return FileUtil.readImportObjectAsBuffer(key)
    .then(function(buf) {
      if (buf.length > maxBytes) throw Boom.entityTooLarge('archive exceeds ' + maxBytes + ' bytes');
      return runCourseImport(buf, { user: user, name: request.payload.name, force: request.payload.force });
    })
    .then(function(data) { cleanup(); return request.success({ data: data }); })
    .catch(function(err) {
      cleanup();
      if (err.isBoom) return request.fail(err);
      console.error('Course import (from-storage) error:', err);
      return request.fail({ error: err.message });
    });
}
```

- [ ] **Step 4: Export it** — add `importCourseFromStorage : importCourseFromStorage` to `module.exports`.

- [ ] **Step 5: Add the route** in `config/api_routes.js` (after the upload-url route). JSON body; `key` shape-validated (defense-in-depth on top of the handler's ownership check):

```js
  ,{
    route : 'POST /api/imports/course/from-storage imports.importCourseFromStorage',
    config : {
      auth: 'session',
      pre : ['canCreateCourse(user)'],
      validate : {
        payload : {
          key   : Joi.string().pattern(/^imports\/tmp\/[^/]+\/[A-Za-z0-9-]+\.zip$/).required(),
          name  : Joi.string().max(140).optional(),
          force : Joi.boolean().optional()
        }
      }
    }
  }
```

- [ ] **Step 6: Run tests** (`TEST_S3=garage`), both mongoose and firestore profiles for the happy path, expect PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(imports): POST /api/imports/course/from-storage import-from-object route"`

---

## Task 6: Client — size branch, signed-URL flow, error surfacing

**Files:**
- Modify: `lib/views/base.html` (expose `largeUpload` to client, alongside `assetsEnabled` at :84)
- Modify: `lib/views/users/includes/import.html` (branch + large flow + error surfacing)
- Test: manual checklist below + optional Playwright (see `test/browser/` / the browser-smoke spike). Client wiring is not covered by the Vitest server harness.

**Interfaces:**
- Consumes: `FileUtil.isSignedUploadAvailable` (indirectly, via server 501), the config emitted in base.html.
- Produces: on the import page, files over the threshold take the signed-URL path when enabled; everything else takes the existing direct POST; every failure shows a message.

- [ ] **Step 1: Expose config to the client** in `lib/views/base.html` — add after the `assetsEnabled` line (:84), inside the same object literal:

```nunjucks
        assetsEnabled     : {{ 'true' if config.features.assets else 'false' }},
        largeUpload       : {
          enabled   : {{ 'true' if (config.imports and config.imports.largeUpload and config.imports.largeUpload.enabled) else 'false' }},
          threshold : {{ config.imports.largeUpload.thresholdBytes if (config.imports and config.imports.largeUpload) else 0 }}
        }
```
(Trace how the surrounding object is exposed as a client global — grep the client for how `assetsEnabled` is read — and read `largeUpload` the same way. Note: the object currently ends `assetsEnabled` with no trailing comma; add one when appending.)

- [ ] **Step 2: Refactor the existing response/fail handlers** in `import.html` so both the direct and large paths share them. Extract the `.done` body of `submitCourse` (lines ~220–245) into `handleCourseResponse(resp)` and the `.fail` body into `courseFail(xhr)`, and a `resetCourseBtn()` for the `.always` body. Rename the current `submitCourse` POST logic to `submitCourseDirect(file, force)`.

- [ ] **Step 3: Add the size branch** — new `submitCourse(force)`:

```js
function submitCourse(force) {
  var file = pendingCourseFile || ($courseFile[0].files[0]);
  if (!file) return;
  var lu = (clientConfig && clientConfig.largeUpload) || {};   // clientConfig = the global from base.html
  if (lu.enabled && file.size > (lu.threshold || 26214400)) {
    return submitCourseLarge(file, force);
  }
  return submitCourseDirect(file, force);
}
```

- [ ] **Step 4: Add the large flow** with an XHR progress bar and graceful fallback:

```js
function submitCourseLarge(file, force) {
  $courseBtn.prop('disabled', true); $courseSpin.show();
  $('#missingRefsWarning').hide(); $('#courseResult').hide(); $('#importAlert').hide();

  $.ajax({ url: '/api/imports/upload-url', method: 'POST', contentType: 'application/json', data: '{}' })
    .done(function(resp) {
      var d = resp && resp.data;
      if (!d || !d.url) { showAlert('Could not start upload.'); resetCourseBtn(); return; }
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', d.url);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = function(e) { if (e.lengthComputable) { /* update a progress element 0..1 */ } };
      xhr.onload = function() {
        if (xhr.status < 200 || xhr.status >= 300) { showAlert('Upload failed (' + xhr.status + ').'); resetCourseBtn(); return; }
        $.ajax({ url: '/api/imports/course/from-storage', method: 'POST', contentType: 'application/json',
                 data: JSON.stringify({ key: d.key, name: $courseName.val() || undefined, force: !!force }) })
          .done(function(r) { if (!r.data) { showAlert(r.error || 'Import failed.'); return; } handleCourseResponse(r); })
          .fail(courseFail).always(resetCourseBtn);
      };
      xhr.onerror = function() { showAlert('Upload failed.'); resetCourseBtn(); };
      xhr.send(file);
    })
    .fail(function(xhr) {
      if (xhr.status === 501) { return submitCourseDirect(file, force); }  // opted out / unavailable → fall back
      showAlert('Could not start upload.'); resetCourseBtn();
    });
}
```

- [ ] **Step 5: Manual verification** (record results in the task report):
  - Small zip (< threshold) → still uses `/api/imports/course` (Network tab shows multipart POST), imports fine.
  - Large zip (> threshold) with `enabled: true` and storage configured → `upload-url` → PUT to storage → `from-storage` → course opens; progress advances.
  - `enabled: false` (override) → large zip uses direct POST and shows the explicit oversize error instead of a silent hang.
  - Missing-refs and force paths behave identically on both routes (shared `handleCourseResponse`).

- [ ] **Step 6: Commit** — `git commit -m "feat(imports): client signed-URL upload path with progress + error surfacing"`

---

## Task 7: Operator runbook (infra, not code)

**Files:**
- Create: `docs/deploy/large-archive-imports-infra.md`

Turns the two operator steps into a documented, discoverable runbook (so they aren't a forgotten sentence).

- [ ] **Step 1: Write the runbook** covering:
  - **GCS deploys (mandi = `trinket-gcr-test`, uindy = `trinket-uindy`)** — grant the runtime SA self-signing so V4 signed URLs work without a private key:
    ```
    RUNTIME_SA=$(gcloud run services describe trinket --region us-central1 --project <PROJECT> \
      --format='value(spec.template.spec.serviceAccountName)')   # empty => default compute SA
    gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
      --member="serviceAccount:$RUNTIME_SA" \
      --role="roles/iam.serviceAccountTokenCreator" --project <PROJECT>
    ```
    Symptom if skipped: `upload-url` 500s / large path unavailable; client falls back to small-only.
  - **Materials-bucket lifecycle rule** (both GCS and garage/S3): delete objects under `imports/tmp/` older than 24 h. Give the `gcloud storage buckets update ... --lifecycle-file` (GCS) and the garage/S3 equivalent.
  - **Self-host (garage):** no IAM step; presigned URLs use the existing S3 key. Note lifecycle rule still recommended.
  - **Opt-out:** to disable, set `imports.largeUpload.enabled: false` in the deploy overlay.

- [ ] **Step 2: Commit** — `git commit -m "docs(imports): operator runbook for large-archive-imports (IAM + lifecycle)"`

---

## Self-Review notes (author)

- **Spec coverage:** upload-url (T4), from-storage + ownership/oversize (T5), signing both backends (T2), refactor with no behavior change (T3), config + opt-out predicate (T1), client branch + error surfacing (T6), infra IAM + lifecycle (T7). Testing section of the spec is covered across T1–T5 unit/integration; client is manual/Playwright (T6) — called out explicitly since the Vitest harness has no browser.
- **Type consistency:** `runCourseImport(zipBuffer, {user,name,force}) -> Promise<data>` is produced in T3 and consumed in T5; handler names `getImportUploadUrl` / `importCourseFromStorage` match between imports.js exports and api_routes.js. `signUploadUrl(bucket,key,contentType,ttlSeconds)` consistent across backends and `FileUtil.signImportUploadUrl(key,contentType,ttlSeconds)`.
- **Known soft spot:** client config global name in base.html is bespoke — T6 Step 1/3 instruct the implementer to trace the `assetsEnabled` read site and mirror it, rather than guessing the accessor.
