# Config-driven Firebase sign-in providers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FirebaseUI login widget render its sign-in buttons from config (`auth.firebase.providers`) instead of a hardcoded list, so per-deploy overlays can set them (mandi = google+password, uindy = google-only).

**Architecture:** `auth.loginPage` already injects `firebaseConfig` into `login-firebase.html`. Add a `providers` list to `default.yaml`, thread it through the controller as `authProviders`, and have the template build FirebaseUI's `signInOptions` from it with a Google fallback. No new mechanism; deploy overlays already override config keys.

**Tech Stack:** Node, Hapi, node-config (0.4.x mutable singleton), nunjucks templates, FirebaseUI 6.1.0, Vitest.

## Global Constraints

- Provider names are the FirebaseUI `PROVIDER_ID` strings: **`'google'`** and **`'password'`** (not `'email'`).
- Backward-compatible default: `auth.firebase.providers: ['google', 'password']` (current behavior — existing firebase deploys unchanged until they opt in).
- Never render a zero-button login box: an empty/unknown provider list falls back to `['google']`.
- The config list controls the **UI only**; the Firebase backend still enforces its own enabled providers. Operators must keep the list in sync with the console.
- Firestore cost discipline: this path touches no DB (login page render only) — keep it that way.
- Run a single test file with: `npx vitest run <path> --fileParallelism=false`.

---

### Task 1: Thread `auth.firebase.providers` through the controller

**Files:**
- Modify: `config/default.yaml` (add `providers` under `auth.firebase:`, ~line 63)
- Modify: `lib/controllers/auth.js` (`loginPage`, the `request.success({...})` at ~line 31)
- Test: `test/unit/auth-login-providers.test.js` (create)

**Interfaces:**
- Consumes: `config.auth.firebase.providers` (array of strings), `require('config')` (already imported at `auth.js:1`).
- Produces: `auth.loginPage(request, reply)` includes `authProviders` (string[]) in its view context, `= (config.auth.firebase && config.auth.firebase.providers) || ['google']`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/auth-login-providers.test.js`:

```js
'use strict';

// auth.loginPage feeds the FirebaseUI login template. It must thread the
// configured provider list (auth.firebase.providers) into the view context as
// `authProviders`, so per-deploy overlays can control which sign-in buttons
// show — and never emit an empty list (unusable login box).

const config = require('config');
const auth   = require('../../lib/controllers/auth');

// Call loginPage with a request stub that captures the view context object
// passed to request.success(...). reply is unused by loginPage.
function invoke() {
  let captured;
  auth.loginPage({ success: (ctx) => { captured = ctx; return ctx; } });
  return captured;
}

describe('auth.loginPage — authProviders', () => {
  it('defaults to the stock two-provider list from config', () => {
    expect(invoke().authProviders).toEqual(['google', 'password']);
  });

  it('threads a per-deploy override through unchanged', () => {
    const orig = config.auth.firebase.providers;
    config.auth.firebase.providers = ['google'];
    try {
      expect(invoke().authProviders).toEqual(['google']);
    } finally {
      config.auth.firebase.providers = orig;
    }
  });

  it('falls back to google-only when firebase config is absent', () => {
    const orig = config.auth.firebase;
    config.auth.firebase = undefined;
    try {
      expect(invoke().authProviders).toEqual(['google']);
    } finally {
      config.auth.firebase = orig;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/auth-login-providers.test.js --fileParallelism=false`
Expected: FAIL — first assertion gets `authProviders: undefined` (controller doesn't emit it yet) and/or `config.auth.firebase.providers` is undefined (not in default.yaml yet).

- [ ] **Step 3: Add the config default**

In `config/default.yaml`, under the `firebase:` block (currently starts `projectId: ''`), add `providers` as the first key:

```yaml
  firebase:
    # Sign-in methods FirebaseUI shows, in order. Keep in sync with the
    # providers actually enabled in the Firebase console — the app cannot
    # auto-discover them. Supported: 'google', 'password'. Override per deploy
    # (e.g. ['google'] for a Google-only deployment).
    providers: ['google', 'password']
    projectId: ''   # Your GCP/Firebase project ID — override in local.yaml
    clientConfig:   # Firebase web SDK config from Project Settings > Your apps
      apiKey: ''
      authDomain: ''
      projectId: ''
      storageBucket: ''
      messagingSenderId: ''
      appId: ''
```

- [ ] **Step 4: Thread it through the controller**

In `lib/controllers/auth.js`, `loginPage`, replace the `return request.success({...})`:

```js
    return request.success({
      firebaseConfig: firebaseConfig,
      authEmulatorUrl: process.env.FIREBASE_AUTH_EMULATOR_URL || null,
      authProviders: (config.auth.firebase && config.auth.firebase.providers) || ['google']
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/auth-login-providers.test.js --fileParallelism=false`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add config/default.yaml lib/controllers/auth.js test/unit/auth-login-providers.test.js
git commit -m "feat(auth): make Firebase sign-in providers config-driven (controller)

Thread auth.firebase.providers into the login view as authProviders,
defaulting to ['google','password'] and falling back to ['google']."
```

---

### Task 2: Build FirebaseUI `signInOptions` from `authProviders`

**Files:**
- Modify: `lib/views/login-firebase.html` (inject `authProviders` near the `firebaseConfig` injection ~line 50; replace the hardcoded `signInOptions` array at ~lines 113-117)
- Test: `test/unit/login-firebase-providers.test.js` (create — static template assertions, matching the `test/unit/course-editor-menu.test.js` pattern)

**Interfaces:**
- Consumes: `authProviders` (string[]) from the view context (Task 1).
- Produces: FirebaseUI `signInOptions` array built at render time; no exported symbols.

- [ ] **Step 1: Write the failing test**

Create `test/unit/login-firebase-providers.test.js`:

```js
'use strict';

// The FirebaseUI login template must build signInOptions from the injected
// authProviders list (config-driven), not a hardcoded two-provider array, so a
// Google-only deploy shows only Google. Static markup assertions — there is no
// DOM/FirebaseUI harness here (same style as course-editor-menu.test.js).

const fs   = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '../../lib/views/login-firebase.html');
const html = fs.readFileSync(TEMPLATE, 'utf8');

describe('login-firebase.html — config-driven signInOptions', () => {
  it('injects the server-provided authProviders list', () => {
    expect(html).toMatch(/var\s+authProviders\s*=\s*\{%\s*if\s+authProviders\s*%\}/);
  });

  it('maps both supported provider names to FirebaseUI PROVIDER_IDs', () => {
    expect(html).toMatch(/google:\s*firebase\.auth\.GoogleAuthProvider\.PROVIDER_ID/);
    expect(html).toMatch(/password:\s*firebase\.auth\.EmailAuthProvider\.PROVIDER_ID/);
  });

  it('builds signInOptions from the list with a google fallback', () => {
    expect(html).toMatch(/signInOptions\s*=\s*.*authProviders/s);
    expect(html).toMatch(/if\s*\(\s*!signInOptions\.length\s*\)/);
  });

  it('no longer hardcodes an unconditional two-provider signInOptions array', () => {
    expect(html).not.toMatch(/signInOptions:\s*\[\s*firebase\.auth\.EmailAuthProvider\.PROVIDER_ID/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/login-firebase-providers.test.js --fileParallelism=false`
Expected: FAIL — the template still has the hardcoded array and no `authProviders` builder.

- [ ] **Step 3: Inject `authProviders` into the rendered script**

In `lib/views/login-firebase.html`, immediately after the `authEmulatorUrl` injection line (currently ~line 51):

```js
  var authEmulatorUrl = {% if authEmulatorUrl %}{{ authEmulatorUrl | json | safe }}{% else %}null{% endif %};
  var authProviders   = {% if authProviders %}{{ authProviders | json | safe }}{% else %}['google']{% endif %};
```

- [ ] **Step 4: Replace the hardcoded `signInOptions`**

Replace the `ui.start('#firebaseui-auth-container', { signInOptions: [ ... ], signInFlow: 'popup', ...` opening (~lines 113-118) with a builder immediately before `ui.start`, then reference it:

```js
  // Map configured provider names -> FirebaseUI PROVIDER_IDs. Unknown names are
  // dropped; an empty result falls back to Google so the widget is never blank.
  var _providerIds = {
    google:   firebase.auth.GoogleAuthProvider.PROVIDER_ID,
    password: firebase.auth.EmailAuthProvider.PROVIDER_ID
  };
  var signInOptions = (authProviders || [])
    .map(function(name) { return _providerIds[name]; })
    .filter(Boolean);
  if (!signInOptions.length) { signInOptions = [_providerIds.google]; }

  ui.start('#firebaseui-auth-container', {
    signInOptions: signInOptions,
    signInFlow: 'popup',
```

Leave the `callbacks: {...}` block and everything after it unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/login-firebase-providers.test.js --fileParallelism=false`
Expected: PASS (4 tests).

- [ ] **Step 6: Sanity-check the whole unit suite didn't regress**

Run: `npx vitest run test/unit/ --fileParallelism=false`
Expected: PASS (all unit tests, including the two new files).

- [ ] **Step 7: Commit**

```bash
git add lib/views/login-firebase.html test/unit/login-firebase-providers.test.js
git commit -m "feat(auth): render FirebaseUI signInOptions from authProviders

Login page builds its provider buttons from the injected authProviders
list (google/password), with a google-only fallback so it's never blank."
```

---

### Task 3: Trial verification (manual — gcr-trial)

**Files:** none committed here — overlay + deploy only.

Not automatable (FirebaseUI renders client-side). This proves the code change *and* that a `deploys/<name>/config` overlay carries the value end-to-end, before the mandi/uindy migration (Track 2).

- [ ] **Step 1:** On the app checkout used for trial, ensure Tasks 1-2 are present.
- [ ] **Step 2:** Add to `deploys/trial-gcr/config/local-production.yaml`:
  ```yaml
  auth:
    firebase:
      providers: ['google']
  ```
- [ ] **Step 3:** Deploy trial (candidate): `TRINKET_DEPLOY=trial-gcr NO_TRAFFIC=1 bash deploy-cloudrun.sh`, then promote per the trial's normal flow.
- [ ] **Step 4:** Load the trial `/login` page; confirm **only the Google button** renders (no email/password form).
- [ ] **Step 5:** Remove the override (or set `['google','password']`), redeploy, confirm **both** render. Revert the trial overlay to its intended state.
- [ ] **Step 6:** Record the result in the PR description / memory; this gates the Track 2 migration.

---

## Self-Review

**Spec coverage** (against `2026-07-23-config-firebase-providers-design.md`):
- §Design 1 (default.yaml key) → Task 1 Step 3 ✅
- §Design 2 (controller threading + `['google']` fallback) → Task 1 Steps 4, test Step 1 ✅
- §Design 3 (template builder + zero-button guard) → Task 2 Steps 3-4 ✅
- §Design 4 (per-deploy overlay values) → belongs to Track 2 (migration plan); Task 3 exercises the trial overlay ✅
- §Testing (controller assertion + manual verification) → Task 1 test + Task 3 ✅
- §Risks (console-sync, backward-compat, order) → encoded in Global Constraints + default value ✅

**Placeholder scan:** none — every code/step block is concrete.

**Type consistency:** `authProviders` (string[]) is the name in the controller payload (Task 1), the template injection (Task 2 Step 3), and the builder input (Task 2 Step 4). Provider names `'google'`/`'password'` and the `_providerIds` map keys match across tasks and Global Constraints.
