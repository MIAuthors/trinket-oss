# Download Student Work — Design

**Status:** Approved design (2026-08-04). Next: implementation plan.
**Target:** Upstream trinketapp PR (backend-agnostic: MongoDB + Firestore).

## Goal

Give instructors a one-click way to download all of their students' submitted
work (plus instructor feedback) for a whole course or for a single assignment,
as a navigable zip archive. Export-only; a transparent archive for assessment,
accreditation, and record-keeping.

## Motivation

Instructors need a portable, self-contained copy of student submissions and the
feedback attached to them — for assessment review, accreditation evidence, and
keeping records independent of the platform. Today the data is only viewable
in-app, per-submission. There is no bulk export of *student* work (the existing
bulk export covers a user's *own* trinkets, and course export covers course
*content*, not submissions).

## Scope

**In scope**
- A "Download student work" button on the **course dashboard** (all assignments).
- A "Download submissions" button on the **assignment (material) view** (one assignment).
- Background-job export (reusing the existing export worker) producing a zip of
  each student's **current** submission per assignment, with feedback + metadata,
  and the assignment prompt for context.

**Out of scope**
- Grades/scores. The system has **no concept of a numeric grade** (grading
  happens in the LMS via LTI; trinket stores *feedback*, not scores). The archive
  captures state + timestamps + feedback, never a score.
- A roster of non-submitters (explicitly declined).
- All-attempts history — only the **current** submission per student is exported.
- Any import/round-trip. This is export-only.

## Key decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Folder layout | By assignment → student |
| Submissions per student | Current submission only (state-preference) |
| Extra context | Assignment prompt trinket + per-submission metadata |
| Non-submitter roster | No |
| Execution | Background job, reuse the export worker |
| Grades | None (not modeled in the system) |

## Archive format

Assignment button exports a single `<assignment-slug>/` subtree; the course
button exports all of them under one archive. Same builder, different scope.

```
student-work-<course-slug>[-<assignment-slug>].zip
  manifest.json                     ← machine-readable index of the whole tree
  <assignment-slug>/
    _assignment/                    ← the prompt trinket (once per assignment)
      <trinket files: main.py / main.html / etc.>
      <assets…>
      trinket.json                  ← prompt metadata (name, lang, shortCode)
    <student-slug>/                 ← one per student who submitted
      <trinket files>               ← the student's current submission
      <assets…>
      feedback.md                   ← instructor feedback comments (rendered)
      submission.json               ← state + timestamps + shortCode
  <assignment-2-slug>/
    …
```

- **Slugs**: assignment slug from the material; student slug from username (fall
  back to a sanitized email local-part or user id if absent). De-duplicate
  collisions with a numeric suffix.
- **`feedback.md`**: the submission's `comments` where `commentType === 'feedback'`,
  rendered as markdown — each with author (display name), timestamp, and body. If
  no feedback, the file is present with a "No feedback" line (keeps the tree
  uniform and self-documenting).
- **`submission.json`**: `{ student, email, state, startedOn, submittedOn,
  lastUpdated, shortCode, lang, hasFeedback }`. No score field.
- **`manifest.json`**: `{ exportedAt, course: {name, slug}, scope:
  "course"|"assignment", assignments: [ { slug, name, materialId,
  submissionCount, students: [ { slug, email, state, submittedOn,
  hasFeedback, folder } ] } ] }`. Mirrors the folder tree for tooling.

## Data sources (all already exist)

- **Assignments** = course materials with `type === 'assignment'`
  (`lib/controllers/course.js` material handling).
- **Submissions per assignment**: `Trinket.findSubmissionsByMaterial(materialId)`
  (`lib/models/trinket.js:477`) — returns per-student state, `comments`,
  `startedOn`, `submittedOn`, `lastUpdated`, `lang`, `shortCode`, grouped by user.
- **Current submission per student**: reuse the state-preference selection
  (`pickCurrentSubmission` / `SUBMISSION_STATE_PREFERENCE` in
  `lib/controllers/course.js:23`) so the export matches what the instructor sees
  on the dashboard: `submittedLate > submitted > completed > started > modified`.
- **Assignment prompt**: the submission trinket's `_parent`
  (`lib/models/trinket.js:40`), or the material's referenced trinket.
- **Feedback**: submission `comments[]` filtered to `commentType === 'feedback'`
  (`lib/models/trinket.js:51`).
- **Files & assets**: reuse `addTrinketToArchive(archive, trinket)` from
  `lib/workers/exports.js` (already streams code + assets + settings, and is
  Firestore-compatible via `.cursor()` / `runQuery`).

## Server design

### Export model (`lib/models/export.js`) — additive, backward-compatible
Add:
- `type`: `'trinkets' | 'course-submissions' | 'assignment-submissions'`, default `'trinkets'`.
- `courseId`: ObjectId ref `Course` (for the two new types).
- `materialId`: ObjectId ref (assignment-submissions only).

Existing exports keep working (`type` defaults to `'trinkets'`). The
`expiresAt`/TTL, `progress`, `status`, `downloadUrl`, `s3Key`, `fileSize` fields
are reused unchanged.

### Endpoints (`lib/controllers/...` + `config/api_routes.js`)
- `POST /api/courses/{courseId}/exports/submissions` → course-wide.
- `POST /api/courses/{courseId}/materials/{materialId}/exports/submissions` → one assignment.

Both: check permission → create an `Export` record with the right `type` +
`courseId` [+ `materialId`] → enqueue on the export queue → return `{ exportId }`.
Reuse the existing export **status-poll + download-link** flow (`findByOwner`,
`findPendingOrProcessing`, the client polling UI) unchanged.

### Worker (`lib/workers/exports.js`)
- Branch the job on `type`. `'trinkets'` keeps the current path.
- New builder `createSubmissionsArchive(export)`:
  1. Load the course; resolve the assignment materials in scope (all, or the one `materialId`).
  2. For each assignment: write `_assignment/` (the prompt trinket via `addTrinketToArchive`).
  3. For each student's **current** submission: write `<student-slug>/` via
     `addTrinketToArchive`, then `feedback.md` and `submission.json`.
  4. Accumulate `manifest.json`; update `progress` every N submissions (as today).
  5. Upload to storage, set `downloadUrl` + `expiresAt`, mark `completed`
     (reuse existing finalize path).
- Reuse the Firestore-safe `.cursor()` / `runQuery` helpers for the per-material
  submission queries so it works on both backends.

### Permissions
Instructor-only: `request.user.hasPermission('view-assignment-submissions',
'course', { id: courseId })` (owner / admin / collaborator) — the same gate that
guards viewing submissions (`lib/controllers/course.js:112`). Anonymous/students → 403.

## Client / UI

- **Course dashboard** (instructor view): a "Download student work" button that
  POSTs the course-level endpoint and shows the existing "export preparing → download
  ready" affordance.
- **Assignment/material view**: a "Download submissions" button that POSTs the
  assignment-level endpoint, same affordance.
- Both reuse the existing export-status/download UI component; no new polling
  machinery.
- Buttons appear only when the user has `view-assignment-submissions` (mirror the
  existing submissions-visibility gate).

## Edge cases

- **Assignment with no submissions**: emit the `<assignment-slug>/_assignment/`
  folder (prompt only) and record `submissionCount: 0` in the manifest — don't skip,
  so the archive reflects the full assignment set.
- **Course with no assignments**: produce an archive with `manifest.json` and no
  assignment folders (valid, empty-but-explained).
- **Student with multiple attempts**: pick the current one (state preference); ignore the rest.
- **Missing username**: slug fallback = sanitized email local-part, else user id.
- **Slug collisions** (two students same slug): append `-2`, `-3`, …
- **Asset fetch failure**: reuse the worker's existing per-asset failure handling
  (count `failed`, continue) so one bad asset can't abort the whole export.
- **Large course**: background job + streaming archive + progress; no single
  request builds the zip (avoids the Cloud Run timeout / memory class of bug seen
  in #9 imports and the roster work).

## Testing

- **Archive builder unit tests**: assignment→student tree shape; current-submission
  selection (state preference); `feedback.md` content (feedback comments only, with
  author/timestamp; "No feedback" when none); `submission.json` fields (and absence
  of any score); `_assignment/` prompt inclusion; empty-assignment folder.
- **Endpoint tests**: permission gate (instructor 200 / student & anon 403); creates
  an `Export` of the correct `type` with `courseId`[+`materialId`]; enqueues the job.
- **Backend-agnostic**: run on both the mongoose and Firestore profiles; the
  submission queries use the Firestore-safe cursor/runQuery helpers.
- **Manifest**: mirrors the folder tree (assignment/student counts match files written).

## Upstream / PR notes

- **Base**: branched off `picup/main` (`3b6feb9`), which already contains the
  Firestore-compatible export worker (the `.cursor()`/`runQuery` refactor, #71/#80).
- **No new feature flag**: available wherever assignments/submissions exist,
  gated by the existing `view-assignment-submissions` permission. Add a config
  flag only if upstream requests one.
- **Additive schema**: the `Export` model changes are backward-compatible
  (`type` defaults to `'trinkets'`), so existing bulk-export deploys are unaffected.
- **Reuse over rewrite**: leans on `addTrinketToArchive`, the export queue, the
  Export model/TTL, and the status/download UI — the PR surface is the two
  endpoints, the worker branch + submissions builder, the schema additions, and
  the two buttons.
