# Configurable access-code enrollment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make course access-code self-enrollment a single, deployment-configurable, self-consistent feature — restore the instructor "generate code" UI, gate both the instructor and student UIs on one flag, and enforce that gate server-side.

**Architecture:** One config flag `features.accessCodeEnrollment` (default off). A `features.js` predicate + a `helpers.js` route `pre`-handler (mirroring the existing `isCoursesEnabled`/`coursesEnabled` pair) enforce it on the four access-code endpoints. The flag is surfaced to the Angular client via `base.html` (mirroring `assetsEnabled`) and gates the restored instructor panel and the student `<join-course>` directive.

**Tech Stack:** Hapi-shim routes with named `pre` handlers, `config` (node-config), AngularJS client (directives/controllers reading `trinketConfig`), Vitest + a `flow` request harness for integration tests (Mongo + Firestore backends).

## Global Constraints

- Flag name is exactly **`features.accessCodeEnrollment`**; stock default **`false`** in `config/default.yaml`.
- **One flag governs all of it** — instructor UI, student UI, and all four server endpoints. They are never independently toggleable.
- **Server enforcement when off:** the three JSON API routes return **404**; the browser link route (`GET /courses/join/{accessCode}`) does **flash + redirect to `/home`** (not a raw 404), using the existing `request.yar.flash(...)` + `reply().redirect("/home")` idiom (`classes.js:149-152`).
- Reuse the existing precedents verbatim in shape: `features.isCoursesEnabled` (`lib/util/features.js`), the `helpers.coursesEnabled` pre-handler (`lib/util/helpers.js:299`), the `assetsEnabled` client exposure (`base.html:84`), the `$scope.emailEnabled = trinketConfig.get('emailEnabled')` consumption (`usersControl.js:10`).
- The instructor panel to restore is the exact 35 lines removed by commit **`c6be18f`** (adapt only to surrounding-markup drift).
- Backend-agnostic: the change adds only a config predicate, a route `pre`-handler, a controller guard, and templates — **no** backend-specific logic. Automated tests run on the **Mongo profile** (`npx vitest run`, in-process `mongodb-memory-server`, no docker). The Firestore profile (`TEST_DB_BACKEND=firestore`) needs the Firestore emulator and adds no coverage for this diff (the new code is backend-neutral; the underlying course-model methods are already covered by the existing suite), so it is not required here.
- Branch `feat/configurable-access-code-enrollment` off `picup/main` (`3b6feb9`); clean direct PR to picup (no convergence dependency).

---

## Task 1: Config flag, server predicate, and client exposure

**Files:**
- Modify: `config/default.yaml` (the `features:` block)
- Modify: `lib/util/features.js`
- Modify: `lib/views/base.html` (the `config.trinket = { … }` object, ~line 84)
- Test: `test/lib/util/features.test.js` (create if absent; otherwise add to the existing features test)

**Interfaces:**
- Produces: `features.isAccessCodeEnrollmentEnabled() -> boolean` (true only when `config.features.accessCodeEnrollment === true`); the client-side `trinketConfig.get('accessCodeEnrollment')` boolean.

- [ ] **Step 1: Write the failing test** — `test/lib/util/features.test.js` (mirror how `isCoursesEnabled` is tested; if no features test file exists, create one):

```javascript
const config   = require('config');
const features = require('../../../lib/util/features');

describe('features.isAccessCodeEnrollmentEnabled', () => {
  let prev;
  beforeEach(() => { prev = config.features.accessCodeEnrollment; });
  afterEach(()  => { config.features.accessCodeEnrollment = prev; });

  it('is true only when the flag is exactly true', () => {
    config.features.accessCodeEnrollment = true;
    expect(features.isAccessCodeEnrollmentEnabled()).toBe(true);
  });
  it('is false when the flag is false', () => {
    config.features.accessCodeEnrollment = false;
    expect(features.isAccessCodeEnrollmentEnabled()).toBe(false);
  });
  it('is false when the flag is undefined', () => {
    delete config.features.accessCodeEnrollment;
    expect(features.isAccessCodeEnrollmentEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run test/lib/util/features.test.js`
Expected: FAIL — `features.isAccessCodeEnrollmentEnabled is not a function`.

- [ ] **Step 3: Add the predicate** to `lib/util/features.js`, mirroring `isCoursesEnabled` (lines 12-18):

```javascript
function isAccessCodeEnrollmentEnabled() {
  if (!config.features || typeof config.features.accessCodeEnrollment === 'undefined') {
    return false;
  }
  return config.features.accessCodeEnrollment === true;
}
```
Add `isAccessCodeEnrollmentEnabled: isAccessCodeEnrollmentEnabled,` to the `module.exports = { … }` block (alongside `isCoursesEnabled`).

- [ ] **Step 4: Add the config default** — in `config/default.yaml`, inside the `features:` block (next to `courses`/`courseImport`):

```yaml
  accessCodeEnrollment: false  # Self-service course join via access code (instructor mints a code, students enter it). Off by default; enable per-deploy for public/self-serve servers without LMS/SMTP. Gates the instructor UI, the student UI, AND the server endpoints together.
```

- [ ] **Step 5: Expose to the client** — in `lib/views/base.html`, in the `config.trinket = { … }` object, add a line after `assetsEnabled` (line 84) — note the comma:

```
        assetsEnabled     : {{ 'true' if config.features.assets else 'false' }},
        accessCodeEnrollment : {{ 'true' if config.features.accessCodeEnrollment else 'false' }}
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `npx vitest run test/lib/util/features.test.js`
Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add config/default.yaml lib/util/features.js lib/views/base.html test/lib/util/features.test.js
git commit -m "feat(config): add features.accessCodeEnrollment flag + client exposure"
```

---

## Task 2: Server-side enforcement (the real gate)

**Files:**
- Modify: `lib/util/helpers.js` (add the `pre`-handler, near `coursesEnabled` ~line 299)
- Modify: `config/api_routes.js` (the three access-code route defs, ~lines 487-508)
- Modify: `lib/controllers/classes.js` (guard at the top of `joinFromLink`)
- Test: `test/lib/api/course-access-code.test.js` (new)

**Interfaces:**
- Consumes: `features.isAccessCodeEnrollmentEnabled()` (Task 1).
- Produces: `helpers.accessCodeEnrollmentEnabled` — a hapi `pre` object `{ assign, method }` that replies `Boom.notFound()` when the flag is off; added to the 3 JSON routes. The browser `joinFromLink` route is guarded in-controller with flash + redirect.

- [ ] **Step 1: Write the failing integration test** — `test/lib/api/course-access-code.test.js` (use the `flow` harness like `course.test.js`; toggle config live like `files.test.js`):

```javascript
const flow   = require('../../helpers/flow.cjs');
const config = require('config');

let prev;
beforeEach(() => { flow.cookies = {}; prev = config.features.accessCodeEnrollment; });
afterEach(()  => { config.features.accessCodeEnrollment = prev; });

describe('Access-code enrollment gate', () => {
  async function makeCourse() {
    await flow.switchUser('user');
    await flow.createCourse();
    return flow.lastResponse.body.course.id;
  }

  describe('when features.accessCodeEnrollment is OFF', () => {
    beforeEach(() => { config.features.accessCodeEnrollment = false; });

    it('POST generateAccessCode is 404', async () => {
      const courseId = await makeCourse();
      await flow.post('/api/courses/' + courseId + '/accessCode', {});
      expect(flow.lastResponse.statusCode).toBe(404);
    });
    it('GET accessCode is 404', async () => {
      const courseId = await makeCourse();
      await flow.get('/api/courses/' + courseId + '/accessCode');
      expect(flow.lastResponse.statusCode).toBe(404);
    });
    it('POST /courses/join is 404', async () => {
      await flow.switchUser('user2');
      await flow.post('/api/courses/join', { accessCode: 'ABC123' });
      expect(flow.lastResponse.statusCode).toBe(404);
    });
  });

  describe('when features.accessCodeEnrollment is ON', () => {
    beforeEach(() => { config.features.accessCodeEnrollment = true; });

    it('an owner can generate a code and a second user can join with it', async () => {
      const courseId = await makeCourse();
      await flow.post('/api/courses/' + courseId + '/accessCode', {});
      expect(flow.lastResponse.statusCode).toBe(200);
      const code = flow.lastResponse.body.accessCode;
      expect(code).toBeTruthy();

      await flow.switchUser('user2');
      await flow.post('/api/courses/join', { accessCode: code });
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.success).toBe(true);
      expect(flow.lastResponse.body.course.id).toBe(courseId);
    });
  });
});
```
(If the `flow` harness exposes `get`/`post` under different names, match the existing usage in `course.test.js` — read it first.)

- [ ] **Step 2: Run it — expect the OFF cases to FAIL**

Run: `npx vitest run test/lib/api/course-access-code.test.js`
Expected: FAIL — the OFF cases return 200/other (no gate yet); the ON case may pass.

- [ ] **Step 3: Add the pre-handler** to `lib/util/helpers.js`, immediately after `coursesEnabled` (~line 307), mirroring it exactly:

```javascript
module.exports.accessCodeEnrollmentEnabled = {
  assign : 'accessCodeEnrollmentEnabled',
  method : function(request, reply) {
    if (features.isAccessCodeEnrollmentEnabled()) {
      return reply(true);
    }
    return reply(Boom.notFound('Access-code enrollment is not enabled'));
  }
}
```
(`features` and `Boom` are already required at the top of the file.)

- [ ] **Step 4: Gate the three JSON routes** in `config/api_routes.js` — prepend the pre-handler to each `pre` array (create `pre` where absent):

```javascript
// GET /api/courses/{courseId}/accessCode
pre : [helpers.accessCodeEnrollmentEnabled, 'course(params.courseId)']
// POST /api/courses/{courseId}/accessCode
pre : [helpers.accessCodeEnrollmentEnabled, 'course(params.courseId)']
// POST /api/courses/join   (add a pre array; it currently has only `validate`)
pre : [helpers.accessCodeEnrollmentEnabled],
```
Confirm `helpers` is already imported in `config/api_routes.js` (it references `helpers.coursesEnabled` elsewhere); if not, add the require used by the sibling route files.

- [ ] **Step 5: Guard the browser link route** — at the very top of `classes.joinFromLink` in `lib/controllers/classes.js`, before any code runs, add (using the file's existing `features` + flash/redirect idiom):

```javascript
joinFromLink : function(request, reply) {
  if (!features.isAccessCodeEnrollmentEnabled()) {
    request.yar.flash("warning", "Course join-by-code is not enabled here.");
    return reply().redirect("/home");
  }
  // …existing body…
```
Ensure `features` is required at the top of `classes.js` (add `var features = require('../util/features');` if not already present).

- [ ] **Step 6: Run the test — expect PASS**

Run: `npx vitest run test/lib/api/course-access-code.test.js`
Expected: PASS (all OFF cases 404; the ON generate→join happy path 200).

- [ ] **Step 7: Run the broader course suite for no regressions**

Run: `npx vitest run test/lib/api/course.test.js`
Expected: PASS (existing course behavior unaffected).

- [ ] **Step 8: Commit**

```bash
git add lib/util/helpers.js config/api_routes.js lib/controllers/classes.js test/lib/api/course-access-code.test.js
git commit -m "feat(courses): enforce access-code enrollment flag on all four endpoints"
```

---

## Task 3: Restore the instructor panel + gate both UIs

**Files:**
- Modify: `public/partials/course_editor.html` (restore the panel, gated)
- Modify: `public/js/courseEditor/controllers/usersControl.js` (expose the flag)
- Modify: `public/partials/directives/join-course.js` (inject `trinketConfig`, set scope flag)
- Modify: `public/partials/directives/join-course.html` (gate the button)

**Interfaces:**
- Consumes: `trinketConfig.get('accessCodeEnrollment')` (Task 1).

- [ ] **Step 1: Restore the instructor "Share Access Code" panel, gated.** In `public/partials/course_editor.html`, immediately after `<div id="access-code-messages"></div>` and before `<div id="add-user-messages"></div>`, insert the block removed by `c6be18f`, wrapping the outer `<div class="row">` with an `ng-if` on the flag:

```html
  <div class="row" ng-if="accessCodeEnrollment">
    <div class="small-12 columns">
      <form name="access-code-form">
        <fieldset ng-class="{'border-on':formToggles.accessCode}" class="border">
          <legend class="clickable-legend" ng-click="toggleForm('accessCode')"><i ng-class="{'hide':formToggles.accessCode}" class="fa fa-chevron-right"></i> Share Access Code</legend>
          <div ng-class="{'show-fields':formToggles.accessCode}" class="collapsed-form">
            <div class="row">
              <div class="small-12 columns">
                <p>Share this access code or link with your students. They'll be able to enter the code from their home page. The link will automatically add them to your course.</p>
              </div>
            </div>
            <div class="row collapse">
              <div class="small-4 columns">
                <p class="join-code faux-input">{{ accessCode }}</p>
              </div>
              <div class="small-4 columns end">
                <a class="button secondary collapse postfix" ng-click="generateAccessCode()"><i ng-class="generatingCode ? 'fa fa-circle-o-notch fa-spin' : 'fa fa-code'"></i> Generate New Access Code</a>
              </div>
            </div>
            <div class="row">
              <div class="small-12 columns">
                <p class="smaller">{{ accessCodeUrl }}</p>
              </div>
            </div>
            <div class="row" ng-show="accessCode.length">
              <div class="small-12 columns">
                <p class="smaller no-margin">Note: Changing the access code invalidates previous access codes.</p>
              </div>
            </div>
          </div>
        </fieldset>
      </form>
    </div>
  </div>
```
(Exact source: `git show c6be18f -- public/partials/course_editor.html`. The only change vs. the original is the `ng-if="accessCodeEnrollment"` on the outer row.)

- [ ] **Step 2: Expose the flag in `usersControl.js`.** Next to `$scope.emailEnabled = trinketConfig.get('emailEnabled');` (line 10), add:

```javascript
      $scope.accessCodeEnrollment = trinketConfig.get('accessCodeEnrollment');
```
(The `generateAccessCode`/`accessCode`/`accessCodeUrl`/`formToggles.accessCode`/`generatingCode` wiring is already present — no other change.)

- [ ] **Step 3: Gate the student directive.** In `public/partials/directives/join-course.js`, inject `trinketConfig` and set a scope flag in `link`:

```javascript
  angular.module('trinket.joinCourse', []).directive('joinCourse', ['$modal', 'trinketConfig', function($modal, trinketConfig) {
    function link(scope, element) {
      scope.courses              = scope.courses     || [];
      scope.coursesById          = scope.coursesById || {};
      scope.buttonClass          = scope.buttonClass || "";
      scope.accessCodeEnrollment = trinketConfig.get('accessCodeEnrollment');
```

- [ ] **Step 4: Gate the button** in `public/partials/directives/join-course.html` — add `ng-if` to the trigger link (leave the `<script type="text/ng-template">` block untouched):

```html
<a class="button" ng-class="buttonClass" ng-if="accessCodeEnrollment" ng-click="openJoinCourse()"><i class="fa fa-user-plus"></i> Join Course</a>
```

- [ ] **Step 5: Manual verification against a local `make mongo` stack** (this is the "stand up a local server" gate; it verifies the Angular gating both ways, which unit tests can't).

Run the stack and click through BOTH states:
```bash
# from the worktree; mongo shape avoids the VeriDose/emulator port dance
make mongo   # app on :3000  (Ctrl-C or `make down-mongo` when done)
```
- **Flag ON** (`config/local.yaml` → `features: { accessCodeEnrollment: true }`, or `NODE_CONFIG` env): as an instructor, open a course's Users panel → the **"Share Access Code"** panel is present → expand → **Generate New Access Code** → a code + join URL appear. As a second user on the home page, the **"Join Course"** button is present → enter the code → enrolled.
- **Flag OFF** (default): the instructor "Share Access Code" panel is **absent**, the student "Join Course" button is **absent**, and hitting `/api/courses/<id>/accessCode` or `/api/courses/join` directly returns **404** (curl).

Record the outcome (what you saw in each state) in the task report.

- [ ] **Step 6: Commit**

```bash
git add public/partials/course_editor.html public/js/courseEditor/controllers/usersControl.js public/partials/directives/join-course.js public/partials/directives/join-course.html
git commit -m "feat(courses): restore instructor access-code panel; gate both UIs on the flag"
```

---

## Final verification (after all tasks)

- [ ] Predicate + gate suites green on the **Mongo profile** (default): `npx vitest run test/lib/util/features.test.js test/lib/api/course-access-code.test.js test/lib/api/course.test.js`. (Firestore profile not required — see Global Constraints.)
- [ ] Manual `make mongo` click-through passed in both flag states (Task 3 Step 5).

## Rollout / deploy matrix (post-PR, after merge to convergence)

Not part of the code, but the validation + deploy plan (per Steve):

- **Trial validation of BOTH states on real servers:**
  - **merge-trial (Mongo, webapps `/home/steve/docker/trinket-trial`):** turn the flag **ON** — set `features.accessCodeEnrollment: true` in that box's config (its compose `NODE_CONFIG` or a `config/local.yaml`), then redeploy (`git pull --ff-only` + `docker compose up -d --build`). Mirrors picup's intended state.
  - **rba-merge-trial (GCP, `deploys/trial-gcr`):** leave the flag **OFF** (inherits the `false` default — no overlay change). Redeploy the NO_TRAFFIC candidate + promote.
- **picup (eventual, via the PR):** opts in with `features.accessCodeEnrollment: true` in its VPS config.
- **mandi/uindy:** inherit `false` — no change.

## Out of scope (YAGNI)
- No per-course toggle; no changes to LTI / upload-student-list / email-invitation paths; no automated browser test for the Angular gating (server enforcement in Task 2 is the automated guarantee; UI gating is verified by the manual click-through + code review).
