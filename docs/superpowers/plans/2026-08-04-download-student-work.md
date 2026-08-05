# Download Student Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two instructor buttons — course dashboard and assignment view — that export every student's current assignment submission plus instructor feedback as a downloadable zip, organized by assignment → student, produced by the existing background export worker.

**Architecture:** Reuse the entire existing bulk-export spine (the `exports` Bull queue, the `Export` model, `uploadToS3`, presigned `/api/exports/{id}/download`, `addTrinketToArchive`). Add one new queue **action** (`student-work-export`) with a new archive builder that walks a course's assignments and students instead of one user's trinkets. Two new POST endpoints enqueue the job; a small client affordance polls the existing status endpoint and surfaces a download link.

**Tech Stack:** Node + Hapi, Mongoose models with a Firestore backend shim (queries must be backend-agnostic), `archiver` for zip, AngularJS 1.x front end (`courseEditor` module), Vitest.

## Global Constraints

- **Backend-agnostic (Mongo + Firestore).** Use `Model.find({...}).then(...)` (materializes to an array on both backends — `lib/db/firestore-backend.js:665`) and the worker's `runQuery(model, method, ...args)` helper. Do **not** add new raw `.cursor()` streaming for submissions (class-sized data). Tests run on both the mongoose and firestore profiles.
- **No grades.** The system has no numeric grade. `submission.json` carries state + timestamps + feedback presence only; never invent a score field.
- **Additive, backward-compatible schema.** `Export.type` defaults to `'trinkets'`; existing bulk exports and existing records must behave exactly as before.
- **Permission gate:** every new endpoint checks `request.user.hasPermission('view-assignment-submissions', 'course', { id: course.id })` and returns `errors.forbidden()` otherwise — identical to `exportMaterialFeedbackCsv` (`lib/controllers/course.js:1475`).
- **Reuse, don't re-implement:** `addTrinketToArchive`, `uploadToS3`, `downloadAsset`, `runQuery`, `parseCodeFiles`, `sanitizeFolderName` (all in `lib/workers/exports.js`); the `Export` model; the `exports` queue; and the existing four `/api/exports*` routes for retrieval.
- **Folder layout** (fixed by design): `<assignment-slug>/_assignment/<prompt files>` and `<assignment-slug>/<student-slug>/<submission files> + feedback.md + submission.json`, plus a top-level `manifest.json`. The assignment-level export is exactly one `<assignment-slug>/` subtree.
- **Comment field names (exact):** feedback lives in `trinket.comments[]` where `commentType === 'feedback'`; body is **`commentText`**, timestamp is **`commented`**, author display is **`displayName`** (fallback `username`/`email`). (`lib/models/trinket.js:51-64`.)
- **Precondition (existing):** `config.aws.buckets.exports.{name,host}` + `config.aws.publicEndpoint` must be set per-deploy — already required by the current bulk export; not new work here. Note it in the PR description.

## Decision to confirm at plan review

**Retrieval UX.** There is no existing course-side "preparing → poll → download" widget to reuse (the bulk export's polling UI is on the library page, and completion email isn't configured on every deploy). This plan adds a **small in-course affordance**: the button POSTs, gets back `exportId`, polls `GET /api/exports/{exportId}` every ~2s, and shows a **Download** link (`GET /api/exports/{exportId}/download`) when `downloadAvailable`. The worker's completion email is a bonus where mail is configured. Alternative (if preferred): email-only + a link to a "My Exports" list. **Task 8 implements the poll+link default.**

## File Structure

- `lib/models/export.js` — add `type` / `courseId` / `materialId` (Task 1).
- `lib/util/submissions.js` *(new)* — `SUBMISSION_STATE_PREFERENCE`, `pickCurrentSubmission`, `latestFeedbackComment`, extracted from `course.js` so the worker and controller share one copy (Task 2).
- `lib/workers/exports.js` — `basePath` option on `addTrinketToArchive`; new `renderFeedbackMarkdown` + `buildSubmissionMeta`; new `createSubmissionsArchive`; new `processStudentWorkExport` + action routing (Tasks 3–6).
- `lib/controllers/course.js` — two new handlers; use the shared util (Tasks 2, 7).
- `config/api_routes.js` — two new routes (Task 7).
- `public/partials/course_dashboard.html`, `public/partials/material_dashboard.html`, `public/js/courseEditor/controllers/dashboardControl.js` — buttons + poll affordance (Task 8).
- Tests alongside under `test/lib/...`.

---

### Task 1: Export model — additive scope fields

**Files:**
- Modify: `lib/models/export.js`
- Test: `test/lib/models/export.test.js`

**Interfaces:**
- Produces: `Export` docs may carry `type` (`'trinkets'` | `'course-submissions'` | `'assignment-submissions'`, default `'trinkets'`), `courseId` (ObjectId), `materialId` (ObjectId). All optional; existing records read back as `type === 'trinkets'`.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/models/export.test.js
'use strict';
const Export = require('../../../lib/models/export');

describe('Export model scope fields', () => {
  it('defaults type to "trinkets" and accepts submission scope', async () => {
    const legacy = await new Export({ _owner: new (require('mongoose').Types.ObjectId)() }).save();
    expect(legacy.type).toBe('trinkets');

    const cid = new (require('mongoose').Types.ObjectId)();
    const mid = new (require('mongoose').Types.ObjectId)();
    const scoped = await new Export({
      _owner: legacy._owner, type: 'assignment-submissions', courseId: cid, materialId: mid
    }).save();
    expect(scoped.type).toBe('assignment-submissions');
    expect(scoped.courseId.toString()).toBe(cid.toString());
    expect(scoped.materialId.toString()).toBe(mid.toString());
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/lib/models/export.test.js` → FAIL (`type` undefined / not saved).

- [ ] **Step 3: Add fields to the schema** in `lib/models/export.js` (after `_owner`):

```js
type          : { type: String, enum: ['trinkets', 'course-submissions', 'assignment-submissions'], default: 'trinkets' },
courseId      : { type: ObjectId, ref: 'Course', index: true },
materialId    : { type: ObjectId, ref: 'Material', index: true },
```

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(export): add type/courseId/materialId scope fields to Export"`

---

### Task 2: Shared submission-selection util

**Files:**
- Create: `lib/util/submissions.js`
- Modify: `lib/controllers/course.js` (import + delete the local copies)
- Test: `test/lib/util/submissions.test.js`

**Interfaces:**
- Produces: `submissions.SUBMISSION_STATE_PREFERENCE` (array), `submissions.pickCurrentSubmission(subs)` → the shown submission or `null`, `submissions.latestFeedbackComment(subs)` → newest `commentType==='feedback'` comment or `null`.
- Behavior must match `lib/controllers/course.js:15-46` exactly (precedence `submittedLate > submitted > completed > started > modified`, newest `lastUpdated` tiebreak).

- [ ] **Step 1: Write the failing test**

```js
// test/lib/util/submissions.test.js
'use strict';
const S = require('../../../lib/util/submissions');

describe('submissions util', () => {
  it('picks by state precedence, newest lastUpdated as tiebreak', () => {
    const subs = [
      { state: 'started',  lastUpdated: new Date('2026-01-01') },
      { state: 'submitted', lastUpdated: new Date('2026-01-02') },
      { state: 'submitted', lastUpdated: new Date('2026-01-03') }
    ];
    const cur = S.pickCurrentSubmission(subs);
    expect(cur.state).toBe('submitted');
    expect(cur.lastUpdated).toEqual(new Date('2026-01-03'));
  });

  it('returns null when empty', () => {
    expect(S.pickCurrentSubmission([])).toBeNull();
  });

  it('returns the newest feedback comment only', () => {
    const subs = [{ comments: [
      { commentType: 'feedback', commentText: 'old', commented: new Date('2026-01-01') },
      { commentType: 'student',  commentText: 'ignore', commented: new Date('2026-02-01') },
      { commentType: 'feedback', commentText: 'new', commented: new Date('2026-01-05') }
    ] }];
    expect(S.latestFeedbackComment(subs).commentText).toBe('new');
  });
});
```

- [ ] **Step 2: Run to verify it fails** (module missing).

- [ ] **Step 3: Create `lib/util/submissions.js`** by moving the three definitions verbatim from `lib/controllers/course.js:15-46` (require `underscore` as `_`), and `module.exports = { SUBMISSION_STATE_PREFERENCE, pickCurrentSubmission, latestFeedbackComment };`.

- [ ] **Step 4: Refactor `lib/controllers/course.js`** — delete the three local functions + the `SUBMISSION_STATE_PREFERENCE` const, add `var submissions = require('../util/submissions');` and replace call sites `pickCurrentSubmission(` → `submissions.pickCurrentSubmission(`, `latestFeedbackComment(` → `submissions.latestFeedbackComment(`. (Leave the inlined if/else ladders at `:1393` and `:1567` alone — out of scope; do not touch behavior.)

- [ ] **Step 5: Run the util test AND the existing course suite** — `npx vitest run test/lib/util/submissions.test.js test/lib/api/course.test.js` → all pass (behavior preserved).

- [ ] **Step 6: Commit** — `git commit -m "refactor(submissions): extract state-preference selection to lib/util/submissions"`

---

### Task 3: `addTrinketToArchive` — optional basePath

**Files:**
- Modify: `lib/workers/exports.js`
- Test: `test/lib/workers/addTrinketToArchive.test.js`

**Interfaces:**
- Consumes: existing `addTrinketToArchive(archive, trinket)`.
- Produces: `addTrinketToArchive(archive, trinket, options)` where `options.basePath` (string, must end with `/`) overrides the default `<lang>/<name>_<shortCode>/`. Omitting `options` keeps current behavior byte-for-byte. Return value (manifest entry `{shortCode,name,lang}`) unchanged.

- [ ] **Step 1: Write the failing test** (use a fake archive that records `append` names):

```js
// test/lib/workers/addTrinketToArchive.test.js
'use strict';
const { addTrinketToArchive } = require('../../../lib/workers/exports');

function fakeArchive() {
  const names = [];
  return { names, append: (_c, opts) => names.push(opts.name) };
}
const trinket = { shortCode: 'abc123', name: 'My Sim', lang: 'python3', code: 'print(1)', assets: [], settings: {} };

describe('addTrinketToArchive basePath', () => {
  it('uses default <lang>/<name>_<shortCode>/ when no options', async () => {
    const a = fakeArchive();
    await addTrinketToArchive(a, trinket);
    expect(a.names.some(n => n.startsWith('python3/My_Sim_abc123/'))).toBe(true);
  });
  it('honors options.basePath', async () => {
    const a = fakeArchive();
    await addTrinketToArchive(a, trinket, { basePath: 'assignment-1/jane/' });
    expect(a.names.every(n => n.startsWith('assignment-1/jane/'))).toBe(true);
    expect(a.names).toContain('assignment-1/jane/metadata.json');
  });
});
```
Requires `addTrinketToArchive` to be exported — add it to `module.exports` in `exports.js` if not already (also export `parseCodeFiles`, `sanitizeFolderName`, `renderFeedbackMarkdown`, `buildSubmissionMeta`, `createSubmissionsArchive` as they land, for testability).

- [ ] **Step 2: Run to verify it fails** (either not exported, or basePath ignored).

- [ ] **Step 3: Implement** — in `addTrinketToArchive`, change the signature to `(archive, trinket, options)` and compute:
```js
options = options || {};
var basePath = options.basePath ||
  ((trinket.lang || 'other') + '/' + sanitizeFolderName(trinket.name || trinket.shortCode) + '_' + trinket.shortCode + '/');
```
Use `basePath` everywhere the function currently rebuilds the path. Add the function(s) to `module.exports`.

- [ ] **Step 4: Run the new test AND any existing worker tests** → pass.
- [ ] **Step 5: Commit** — `git commit -m "refactor(export): addTrinketToArchive accepts options.basePath"`

---

### Task 4: Feedback + submission-metadata renderers

**Files:**
- Modify: `lib/workers/exports.js` (add two pure helpers + export them)
- Test: `test/lib/workers/submissionRenderers.test.js`

**Interfaces:**
- Produces:
  - `renderFeedbackMarkdown(comments)` → markdown string. Filters `commentType === 'feedback'`, sorted oldest→newest by `commented`; each block: `### <displayName||username||email||'Instructor'> — <ISO commented>` then `commentText`. Returns `"_No feedback._\n"` when none.
  - `buildSubmissionMeta({ student, submission })` → object `{ student, email, state, startedOn, submittedOn, lastUpdated, shortCode, lang, hasFeedback }`. **No score.** Dates as ISO strings or null.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/workers/submissionRenderers.test.js
'use strict';
const { renderFeedbackMarkdown, buildSubmissionMeta } = require('../../../lib/workers/exports');

describe('renderFeedbackMarkdown', () => {
  it('includes only feedback comments, oldest first, with author + time', () => {
    const md = renderFeedbackMarkdown([
      { commentType: 'feedback', commentText: 'Good start', commented: new Date('2026-01-02'), displayName: 'Prof X' },
      { commentType: 'student',  commentText: 'thanks',     commented: new Date('2026-01-03'), displayName: 'Jane' }
    ]);
    expect(md).toContain('Prof X');
    expect(md).toContain('Good start');
    expect(md).not.toContain('thanks');
  });
  it('says no feedback when none', () => {
    expect(renderFeedbackMarkdown([])).toMatch(/No feedback/i);
  });
});

describe('buildSubmissionMeta', () => {
  it('captures state/timestamps and never a score', () => {
    const meta = buildSubmissionMeta({
      student: { username: 'jane', email: 'jane@x.edu' },
      submission: { state: 'submitted', submittedOn: new Date('2026-01-02'), startedOn: new Date('2026-01-01'),
                    lastUpdated: new Date('2026-01-02'), shortCode: 'abc', lang: 'python3',
                    comments: [{ commentType: 'feedback' }] }
    });
    expect(meta.state).toBe('submitted');
    expect(meta.hasFeedback).toBe(true);
    expect(meta).not.toHaveProperty('score');
    expect(meta).not.toHaveProperty('grade');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement both helpers** in `exports.js` (pure functions; `hasFeedback = (submission.comments||[]).some(c => c.commentType==='feedback')`). Export them.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(export): feedback.md and submission.json renderers"`

---

### Task 5: `createSubmissionsArchive` builder

**Files:**
- Modify: `lib/workers/exports.js` (new builder + model requires: `Course`, `Trinket` already there; add `Material` if needed via `course.populate`)
- Test: `test/lib/workers/createSubmissionsArchive.test.js`

**Interfaces:**
- Consumes: Task 2 (`submissions.pickCurrentSubmission`), Task 3 (`addTrinketToArchive` w/ basePath), Task 4 (renderers), `Trinket.findSubmissionsByMaterial`, `Trinket.findById`, course→lessons→materials populate.
- Produces: `createSubmissionsArchive(exportRecord, tempFile)` → Q promise resolving `{ processed, failed, assignmentCount }`. Writes the by-assignment→student tree + `manifest.json`. Honors `exportRecord.type`: `assignment-submissions` restricts to `exportRecord.materialId`; `course-submissions` covers all assignment materials in `exportRecord.courseId`.

**Builder algorithm (implement in this order):**
1. Load course: `runQuery(Course.model, 'findById', exportRecord.courseId)`.
2. Enumerate assignment materials via the two-step populate (`lib/controllers/course.js:1220-1252` pattern), select `'name slug type trinket'`, keep `material.type === 'assignment'`; if `type === 'assignment-submissions'`, keep only the one whose `id === exportRecord.materialId`.
3. Slug helper: `assignmentSlug = sanitizeFolderName(material.name)`; student slug from `user.username || sanitizeFolderName(email.split('@')[0]) || userId`, de-duplicated with a `-2/-3` suffix per assignment via a `Set`.
4. Per assignment: write the prompt once → `Trinket.findById(material.trinket.trinketId)` then `addTrinketToArchive(archive, prompt, { basePath: assignmentSlug + '/_assignment/' })`. If the prompt is missing, skip the `_assignment/` folder (don't fail).
5. Per assignment: `Trinket.findSubmissionsByMaterial(material.id)` → for each student group, `pickCurrentSubmission(group.submissions)`; skip if null.
6. For the current submission: `Trinket.findById(current.trinketId)` to get code/assets → `addTrinketToArchive(archive, subTrinket, { basePath: assignmentSlug + '/' + studentSlug + '/' })`; then `archive.append(renderFeedbackMarkdown(current.comments), { name: base + 'feedback.md' })` and `archive.append(JSON.stringify(buildSubmissionMeta({student, submission: current}), null, 2), { name: base + 'submission.json' })`. Look up `student` via the course's `users` array (has `email`/`username`/`displayName`) keyed by `group._id`, else `runQuery(User.model,'findById',group._id)`.
7. Accumulate `manifest = { exportedAt, course:{name,slug}, scope, assignments:[ { slug, name, materialId, submissionCount, students:[{ slug, email, state, submittedOn, hasFeedback, folder }] } ] }`; append as `manifest.json`; `archive.finalize()`.
8. Progress: `runQuery(Export.model,'findByIdAndUpdate', exportRecord._id, {'progress.processed': processed,'progress.failed': failed})` every 10 submissions and at the end.
9. Wrap the same `archiver`/`createWriteStream(tempFile)`/deferred pattern as `createExportArchive`.

- [ ] **Step 1: Write the failing test** — seed (mongoose profile) a course + lesson + assignment material (with a prompt trinket) + two students each with a submission trinket (`_creator`, `materialId`, `courseId`, `submissionState:'submitted'`, one with a `comments:[{commentType:'feedback',commentText:'nice',commented:new Date()}]`). Build an `Export({type:'course-submissions',courseId})`, call `createSubmissionsArchive(exp, tmp)`, then unzip `tmp` (use `adm-zip` or `unzipper`, whichever the repo already has — check `package.json`) and assert entry names: `manifest.json`, `<assignment>/_assignment/...`, `<assignment>/<student1>/main.py`, `<assignment>/<student1>/feedback.md`, `<assignment>/<student1>/submission.json`, and that the feedback student's `feedback.md` contains `nice`. Assert `assignment-submissions` scope emits only the one assignment subtree.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `createSubmissionsArchive`** per the algorithm.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(export): createSubmissionsArchive builds by-assignment/student archive"`

---

### Task 6: Worker action + `processStudentWorkExport`

**Files:**
- Modify: `lib/workers/exports.js`
- Test: `test/lib/workers/processStudentWorkExport.test.js`

**Interfaces:**
- Consumes: Task 5 builder; existing `uploadToS3`, `runQuery`, `sendCompletionEmail`/`sendFailureEmail`.
- Produces: queue handles `job.data.action === 'student-work-export'` → `processStudentWorkExport(job)`. Job data: `{ action, exportId, userId }` (the `Export` record already carries `type`/`courseId`/`materialId`). On success the `Export` becomes `completed` with `downloadUrl`/`s3Key`/`expiresAt`/`fileSize`; on failure `failed` with `errorMessage`.

- [ ] **Step 1: Write the failing test** — create an `Export({_owner, type:'course-submissions', courseId, status:'pending'})` for a seeded course (as Task 5), stub `uploadToS3` (monkeypatch the module export or point `config.aws` at a local dir / use the in-memory queue and assert the record reaches `completed` with an `s3Key`). Enqueue `{action:'student-work-export', exportId, userId}` on the in-memory queue (redis disabled in test) and await; assert `Export.findById` → `status:'completed'`, `progress.processed >= 1`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `processStudentWorkExport`** — mirror `processBulkExport` (`exports.js:95`) but: temp filename `student-work-<hash>.zip`, `s3Key = 'exports/' + userId + '/' + filename`, load the `Export` record (for `courseId`/`materialId`/`type`), call `createSubmissionsArchive(exportRecord, tempFile)`, set `trinketCount`/`progress.total` from the result's `processed`, then the identical `uploadToS3` → `completed` finalize + email + unlink, and the identical `.fail(...)` path. Add `else if (action === 'student-work-export') return processStudentWorkExport(job);` in the `exportsQueue.process` dispatch (`exports.js:84`).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(export): student-work-export queue action + worker"`

---

### Task 7: Endpoints + routes

**Files:**
- Modify: `lib/controllers/course.js` (two handlers), `config/api_routes.js` (two routes)
- Test: `test/lib/api/course-export-submissions.test.js`

**Interfaces:**
- Produces:
  - `POST /api/courses/{courseId}/exports/submissions` → `course.exportCourseSubmissions`
  - `POST /api/courses/{courseId}/materials/{materialId}/exports/submissions` → `course.exportAssignmentSubmissions`
  - Both: 403 unless `view-assignment-submissions`; else create `Export({_owner:request.user.id, type, courseId[, materialId], status:'pending'})`, enqueue `{action:'student-work-export', exportId, userId}` on `require('../util/queues').exports()`, and `request.success({ success:true, data:{ exportId, status:'pending' } })`. Reuse `Export.findPendingOrProcessing(userId)` for in-flight dedup (fail with `{error, exportId}` if one is running). **Skip** the 1-hour `findRecentCompleted` cooldown (instructor action).
- Consumes: `request.pre.course` (existing course pre-handler on these routes).

- [ ] **Step 1: Write the failing test** — as an instructor (owner) POST the course endpoint → 200 + `data.exportId`; assert an `Export` with `type:'course-submissions'` + `courseId` exists. POST the assignment endpoint → `type:'assignment-submissions'` + `materialId`. As a non-member user → 403. (Use the `flow` helper + `defaults` like `test/lib/api/course.test.js`; enrol/seed as needed.)
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement the two handlers** in `course.js` (model this on `exportMaterialFeedbackCsv`'s gate at `:1475`; require `Export` + the queue at the top of the file). Register both routes in `config/api_routes.js` next to the other `courses/{courseId}` routes, `auth: 'session'`, with the existing course pre-handler.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(course): endpoints to export course/assignment student work"`

---

### Task 8: Client buttons + poll/download affordance

**Files:**
- Modify: `public/js/courseEditor/controllers/dashboardControl.js`, `public/partials/course_dashboard.html`, `public/partials/material_dashboard.html`
- Test: manual browser smoke (no Angular unit harness in repo); document the smoke steps in the PR.

**Interfaces:**
- Consumes: the two endpoints (Task 7) and existing `GET /api/exports/{exportId}` status endpoint.
- Produces: a shared `$scope.exportStudentWork(scope)` that POSTs the right endpoint, then polls status and exposes `$scope.studentWorkExport = { running, ready, downloadUrl, error }` for the templates.

- [ ] **Step 1** In `dashboardControl.js` add:
```js
$scope.studentWorkExport = { running: false, ready: false, downloadUrl: null, error: null };
$scope.canViewSubmissions = trinketRoles.hasPermission('view-assignment-submissions', 'course', { id: $scope.courseId });

$scope.exportStudentWork = function() {
  var target = $scope.material && $scope.material.id
    ? $scope.material.customPOST({}, 'exports/submissions')          // assignment view
    : $scope.course.customPOST({}, 'exports/submissions');           // course dashboard
  $scope.studentWorkExport = { running: true, ready: false, downloadUrl: null, error: null };
  target.then(function(res) {
    var id = res.data && res.data.exportId;
    if (!id) { $scope.studentWorkExport = { running:false, error:'Could not start export' }; return; }
    pollExport(id);
  }, function() { $scope.studentWorkExport = { running:false, error:'Could not start export' }; });
};

function pollExport(id) {
  $scope.course.customGET('../../exports/' + id)   // GET /api/exports/{id}
    .then(function(r) {
      var d = r.data || {};
      if (d.status === 'failed') { $scope.studentWorkExport = { running:false, error: d.errorMessage || 'Export failed' }; return; }
      if (d.downloadAvailable)   { $scope.studentWorkExport = { running:false, ready:true, downloadUrl: d.downloadUrl }; return; }
      $timeout(function(){ pollExport(id); }, 2000);
    }, function(){ $scope.studentWorkExport = { running:false, error:'Export status error' }; });
}
```
(If `course.customGET('../../exports/'+id)` path-joining is awkward with Restangular, fall back to `$http.get(trinketConfig.getUrl('/api/exports/'+id))` — inject `$http`/`trinketConfig` as `root.js` does. Confirm which resolves cleanly during implementation.)

- [ ] **Step 2** Course dashboard button — in `public/partials/course_dashboard.html` `#list-menus`:
```html
<button class="button small" ng-if="canViewSubmissions" ng-click="exportStudentWork()" ng-disabled="studentWorkExport.running">
  <i ng-class="studentWorkExport.running ? 'fa fa-circle-o-notch fa-spin' : 'fa fa-download'"></i> Download student work
</button>
<a ng-if="studentWorkExport.ready" ng-href="{{ studentWorkExport.downloadUrl }}" class="button small success">
  <i class="fa fa-check"></i> Download ready
</a>
<span ng-if="studentWorkExport.error" class="alert-box alert">{{ studentWorkExport.error }}</span>
```

- [ ] **Step 3** Assignment button — in `public/partials/material_dashboard.html`, next to the existing Feedback CSV anchor (~line 20), add the same three elements (they read the same `$scope.studentWorkExport`; the `exportStudentWork()` function auto-targets the material because `$scope.material.id` is set on this route).

- [ ] **Step 4: Manual smoke** (local `make gcp` or `make mongo` stack, logged in as an instructor with a course that has an assignment + a couple of submissions): click each button → spinner → "Download ready" → the zip opens with the `<assignment>/<student>/` tree, `feedback.md`, `submission.json`. Record the steps + result in the PR description.

- [ ] **Step 5: Commit** — `git commit -m "feat(ui): Download student work buttons on course dashboard + assignment view"`

---

## Final review & wrap-up

After Task 8: run the full suite on **both** profiles — `npx vitest run` (mongoose) and the Firestore profile (per repo convention) — confirm green. Then use **superpowers:finishing-a-development-branch** to open the PR to `picup/main` (and note the upstream trinketapp target). PR description must call out: the `aws.buckets.exports` per-deploy precondition, the "no grades" scope, and the retrieval-UX decision.
