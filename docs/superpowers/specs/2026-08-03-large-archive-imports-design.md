# Large Archive Imports — Design

**Date:** 2026-08-03
**Branch:** `large-archive-imports` (off `picup/main`)
**Status:** design — pending review, then implementation plan

## Problem

Course archives larger than **32 MiB** fail to import on the Cloud Run deploys
(mandi, uindy) **silently** — no success, no error. Root cause (confirmed by
investigation, MIAuthors #9): **Cloud Run rejects HTTP/1 requests over 32 MiB at
the ingress**, before they reach the container. The request never hits the app,
so nothing is logged and the client shows neither the green success box nor an
error.

Key facts established:
- The app's own import route already allows **50 MB** (`config/api_routes.js`,
  `POST /api/imports/course`, `payload.maxBytes = 50 * 1024 * 1024`). So the app
  is not the limit — Cloud Run's ingress is.
- The limit is **GCP/Cloud-Run-specific**. The self-host (Mongo/garage) stack has
  no such cap; its ceiling is the app's 50 MB plus whatever the fronting reverse
  proxy allows (Apache defaults unlimited; nginx defaults 1 MB).
- Raising container memory (512 Mi → 2 Gi) did **not** help — it is not a memory
  problem. A 40 MiB course imports fine end-to-end and peaks at ~360 MB RSS
  (measured on the Firestore emulator with the full asset path). Memory only
  becomes relevant *after* this fix lets big archives reach the app.
- Aaron Titus's dashboards are 35.2 MiB and 38.5 MiB — both over 32 MiB.

## Approach

Route **large** archives around the ingress cap with a **signed-URL
direct-to-storage upload**: the browser uploads the zip straight to GCS/S3 (which
never transits Cloud Run), then asks the app to import from that stored object.
**Small** imports keep the existing direct multipart POST unchanged.

Decisions (locked in brainstorming):
- **Mechanism:** signed-URL direct-to-storage (not chunked, not HTTP/2).
- **Trigger:** client switches to the signed-URL path only when the file exceeds
  a **~25 MiB threshold** (safely under 32 MiB); otherwise direct POST.
- **Scope:** all backends — GCS (mandi/uindy) via IAM-signed V4 URLs, S3/garage
  (self-host) via presigned PUT. Additive to picup, not disruptive.
- **Ceiling:** **100 MiB**, configurable (`imports.maxArchiveBytes`). Comfortably
  within the 2 Gi budget (extrapolated peak ~0.8–1 GB).
- **No feature flag:** the large path is auto-available whenever storage is
  configured; if it is not, the client falls back to direct POST (small files
  only). Nothing new to toggle per deploy.
- **Temp object location:** reuse the existing **`materials`** bucket under an
  `imports/tmp/` prefix (no new bucket) + a lifecycle rule for cleanup.

### Flow

```
Client picks the path by file size:

  size ≤ 25 MiB  → POST /api/imports/course (multipart)        [UNCHANGED]

  size > 25 MiB  → 1. POST /api/imports/upload-url
                        ← { url, key, expiresAt }
                   2. PUT <zip> to `url`         (browser → GCS/S3, no Cloud Run)
                   3. POST /api/imports/course/from-storage { key, name, force }
                        server: verify key owner → download object →
                        enforce 100 MiB → EXISTING import pipeline → 200 { data }
                        finally: delete temp object
```

## Components

### Server

**New route — `POST /api/imports/upload-url`** (`config/api_routes.js` +
`lib/controllers/imports.js`)
- Auth `session`, pre `canCreateCourse(user)` (same guard as the import route).
- Generates a user-scoped key: `imports/tmp/{userId}/{uuid}.zip`.
- Returns `{ url, key, expiresAt }` where `url` is a signed **PUT** URL, TTL
  ~15 min, constrained to `content-type: application/zip` (and
  `application/octet-stream`).
- 200 `{ data: { url, key, expiresAt } }`. If storage is not configured, 501 /
  a clear "large upload not available" so the client falls back gracefully.

**New route — `POST /api/imports/course/from-storage`**
(`config/api_routes.js` + `lib/controllers/imports.js`)
- Auth `session`, pre `canCreateCourse(user)`.
- Body (JSON, tiny): `{ key: string, name?: string(≤140), force?: boolean }`.
- **Ownership check:** the `{userId}` segment embedded in `key` MUST equal the
  authenticated user's id; else 403. (Prevents importing another user's object.)
- Download the object (`readObject(key)`), enforce
  `size ≤ imports.maxArchiveBytes` (else 413 with a clear message).
- Feed the buffer into the **existing** pipeline. Refactor `importCourse` so the
  post-`JSZip.loadAsync` logic (autoImportBundledTrinkets → parseCourseZip →
  resolveAllRefs → createCourseFromChapters) is a shared function
  `runCourseImport(zipBuffer, { user, name, force })` used by BOTH the multipart
  route and this one. No behavior change to the pipeline itself.
- `finally`: `deleteObject(key)` (best-effort; lifecycle rule is the backstop).

**New storage helpers** (`lib/util/file.js` — alongside `FileUtil._upload`)
- `FileUtil.signUploadUrl(key, contentType, ttlSeconds)` → signed PUT URL,
  branching on `config.storage.backend`:
  - **GCS:** `@google-cloud/storage` `file.getSignedUrl({ version: 'v4',
    action: 'write', expires, contentType })`. With no private key on the runtime
    SA, the library signs via the IAM `signBlob` API — requires the SA to hold
    `roles/iam.serviceAccountTokenCreator` on itself (see Infra).
  - **S3/garage:** `s3.getSignedUrl('putObject', { Bucket, Key, Expires,
    ContentType })` (aws-sdk, already a dependency).
- `FileUtil.readObject(key)` → `Promise<Buffer>` (GCS `file.download()` /
  S3 `getObject`).
- `FileUtil.deleteObject(key)` → best-effort delete.
- `FileUtil.isSignedUploadAvailable()` → boolean (storage configured + backend
  supported), used by the upload-url route and surfaced to the client.

### Client (`lib/views/users/includes/import.html`)

- On course submit, branch on `file.size`:
  - `> largeUploadThresholdBytes` **and** large-upload available →
    signed-URL flow: `GET/POST upload-url` → `PUT` to storage with an
    **XHR progress bar** → `POST from-storage` → on `{status:'ok'}` navigate to
    the course.
  - else → existing `submitCourse()` multipart POST.
- **Error surfacing (fixes the silent-failure):** every failure path — no URL,
  PUT non-2xx, oversize (413), import error, or `missing_refs` — shows an
  explicit message (red box), never a dead end. This also patches the existing
  gap where a failed import shows nothing.
- The threshold + availability are exposed to the client the same way other
  config reaches it (`trinketConfig.get(...)` via `base.html`), mirroring the
  `assetsEnabled` pattern.

### Config (`config/default.yaml`)

```yaml
imports:
  maxArchiveBytes: 104857600          # 100 MiB — validated ceiling on from-storage
  largeUploadThresholdBytes: 26214400 # 25 MiB — client switch point (< 32 MiB cap)
```
Both overridable per deploy. No feature flag.

## Security

- Signed URL is scoped to a **single key**, short TTL (~15 min),
  content-type-constrained.
- The key path embeds `{userId}`; `from-storage` re-derives and **enforces
  ownership** against the session user before importing.
- Size ceiling enforced server-side on the downloaded object (a signed PUT alone
  can't fully bound size on all backends, so the authority is the server check at
  import time).
- Temp objects live under `imports/tmp/` and are deleted post-import; a lifecycle
  rule sweeps abandoned ones.

## Cleanup

- Explicit `deleteObject(key)` in a `finally` around the import.
- **Bucket lifecycle rule** on the `materials` bucket: delete objects under
  `imports/tmp/` older than **24 h**. (Documented gcloud/console step per deploy;
  belongs with the deploy config, not code.)

## Infra (one-time, operator-run — not code)

For each GCS deploy (mandi = `trinket-gcr-test`, uindy = `trinket-uindy`), grant
the Cloud Run runtime service account permission to self-sign:

```
gcloud iam service-accounts add-iam-policy-binding <RUNTIME_SA> \
  --member="serviceAccount:<RUNTIME_SA>" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project <PROJECT>
```
(`<RUNTIME_SA>` = the service's runtime SA — determine via
`gcloud run services describe trinket --format='value(spec.template.spec.serviceAccountName)'`;
if empty, it's the project's default compute SA.)

Self-host (garage) needs no IAM step — presigned URLs use the existing S3 key.

## Testing

- **Unit:** `signUploadUrl` produces a valid signed PUT for GCS and for S3
  (shape/params); `from-storage` ownership check (mismatched userId → 403);
  oversize object → 413; `isSignedUploadAvailable` reflects config.
- **Integration (flow harness):** seed an object into test storage (garage via
  the existing `TEST_S3=garage` profile), `POST from-storage`, assert the course
  is created — reusing the import-repro plumbing from the #9 investigation.
  Run on **both** the Mongo/garage and Firestore-emulator profiles.
- **Client:** small file → direct POST path; large file → signed-URL path
  (threshold branch); error paths surface messages.
- **Regression:** the existing multipart `POST /api/imports/course` is byte-for-
  byte unchanged for small imports (shared `runCourseImport`).

## Out of scope / non-goals

- **Streaming the zip** (yauzl / chunked decompression) — rejected; the pipeline
  already peaks at a modest ~360 MB and is sequential. Not needed.
- **HTTP/2 end-to-end** — rejected; the app is HTTP/1 and h2c is risky.
- **Chunked multi-POST** — rejected; on stateless multi-instance Cloud Run it
  still needs shared storage plus session/reassembly state — more moving parts
  than a single signed PUT for the same result.
- **Trinket-archive imports** (`POST /api/imports/trinkets`, also 50 MB) — same
  technique would apply, but out of scope for v1 (course import is the reported
  need). The `signUploadUrl`/`from-storage` shape is written generically enough
  to extend later.
- Changing the 2 Gi memory setting (already done; keep it — it's what lets a
  100 MiB course fit).
