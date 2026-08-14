# Per-trinket runtime setting — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author store a runtime choice on the trinket itself, so it survives forks, second embeds, and LTI launches — instead of living only on a share link.

**Architecture:** One new field, `settings.runtime`, on the `Trinket` and `Draft` models. The pure `chooseRuntime()` router gains a `storedRuntime` input and one reordered rule. The choice is set from the existing "Trinket Settings" modal and saved through the existing `payload.settings` path. No new endpoint, no new surface.

**Tech Stack:** Node/hapi, mongoose (+ a Firestore backend), nunjucks templates, jQuery embed client (ES5), vitest for unit/API, Playwright for browser.

**Spec:** `docs/superpowers/specs/2026-08-12-trinket-runtime-setting-design.md` — read §2 (decisions), §3 (router ordering) and §5 (validation) before starting.

## Global Constraints

- Client-side files under `public/js/` are **ES5** — `var`, no arrow functions, no `const`/`let`, no template literals. Match the surrounding style exactly.
- The only valid values are `''`, `'worker'`, `'main'`. `''` means "follow the deploy". Never `null`, never absent, never any other string.
- `runtime-router.js` must stay **pure** — no DOM, no Pyodide, no config lookups — so every rule stays testable in node.
- The share dialog is **mirrored in two templates**: `lib/views/includes/shareModals.html` is the live one; `public/js/library/trinkets/detail/share.html` renders nowhere but is kept in step deliberately. Any change to one is made to both.
- The settings modal is gated per trinket type by `config.app.runtimeOption` (`[python3, pyodide]`). A control that cannot affect the trinket in front of the user must not render.
- Existing tests in `test/unit/runtime-router.test.js` must pass **unchanged**. If one needs editing, the reordering claim in spec §3 is wrong — stop and report rather than adjusting the test.
- Unit tests run in an amd64 container: `docker run --rm -v <repo>:/app -v gcr-base-nm:/app/node_modules -w /app --platform linux/amd64 node:20-bullseye bash -lc 'npx vitest run'`. Browser tests run against the local stack at `http://localhost:3001` via `npx playwright test` from `test/browser/`.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/models/trinket.js` | add `settings.runtime` |
| `lib/models/draft.js` | same field — the modal reads draft state first |
| `lib/controllers/trinket.js` | whitelist `settings.runtime` on write (both sites) |
| `public/js/embed/runtime-router.js` | `storedRuntime` input, rule reorder, new reasons, notice text |
| `public/js/embed/pyodide.js` | read the stored value, whitelist it, pass it to the router |
| `public/js/embed/embed.js` | let `settingsChange` handle a `<select>` |
| `lib/views/includes/embed-settings.html` | the new row |
| `lib/views/includes/shareModals.html` | share dropdown re-labelled as an override |
| `public/js/library/trinkets/detail/share.html` | the mirror, kept in step |
| `docs/DEPLOY-OVERLAY-GUIDE.md` | document the setting and the precedence |

---

### Task 1: Model field and server-side validation

**Files:**
- Modify: `lib/models/trinket.js` (settings block, ~:27-30)
- Modify: `lib/models/draft.js` (settings block, ~:9-12)
- Modify: `lib/controllers/trinket.js` (two `request.payload.settings` sites, ~:1100 and ~:1163)
- Test: `test/lib/api/trinketRuntimeSetting.test.js` (new)

**Interfaces:**
- Produces: `settings.runtime` on both models; `sanitizeSettings(settings)` in the trinket controller.

- [ ] **Step 1: Write the failing test**

Create `test/lib/api/trinketRuntimeSetting.test.js`. Follow the setup style of an existing API test in `test/lib/api/` (copy its imports and harness bootstrapping verbatim — do not invent a new harness).

```js
// #128: settings.runtime is client-supplied and reaches storage wholesale.
// The DRAFT path uses findOneAndUpdate, which does NOT run mongoose validators,
// so the schema enum alone does not constrain it. See spec §5.
describe('settings.runtime validation', () => {
  it('stores a valid value', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'worker' } });
    expect((await getTrinket(t.id)).settings.runtime).toBe('worker');
  });

  it('rejects a value outside the enum, storing the empty default', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'nonsense' } });
    expect((await getTrinket(t.id)).settings.runtime).toBe('');
  });

  it('rejects a non-string just as firmly', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: { $ne: null } } });
    expect((await getTrinket(t.id)).settings.runtime).toBe('');
  });

  it('leaves the other settings untouched', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'main', testsEnabled: true } });
    const got = (await getTrinket(t.id)).settings;
    expect(got.runtime).toBe('main');
    expect(got.testsEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `docker run --rm -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app --platform linux/amd64 node:20-bullseye bash -lc 'npx vitest run test/lib/api/trinketRuntimeSetting.test.js'`
Expected: FAIL — `settings.runtime` is `undefined`.

- [ ] **Step 3: Add the field to both models**

In `lib/models/trinket.js`:

```js
      settings      : {
        autofocusEnabled : { type: Boolean, default: true },
        testsEnabled     : { type: Boolean, default: false },
        // #128: '' means "follow the deploy". Chosen over null/absent so every
        // existing trinket acquires it with no migration, and so a deploy that
        // later enables the worker still moves its undecided trinkets.
        runtime          : { type: String, enum: ['', 'worker', 'main'], default: '' }
      },
```

In `lib/models/draft.js` — the settings modal reads draft state in preference to trinket state, so without this the control appears not to save while a draft is in play:

```js
      , settings         : {
          autofocusEnabled : { type : Boolean, default : true },
          testsEnabled     : { type : Boolean, default : false },
          runtime          : { type : String, enum : ['', 'worker', 'main'], default : '' }
        }
```

- [ ] **Step 4: Whitelist on write**

In `lib/controllers/trinket.js`, beside the existing `validRuntime()` helper:

```js
// #128: `settings` arrives from the client and is assigned wholesale below. The
// draft path is Draft.findOneAndUpdate, and mongoose does NOT run validators on
// findOneAndUpdate, so the schema enum does not constrain what lands there.
// Anything that is not one of the three known values becomes ''.
function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  var clean = Object.assign({}, settings);
  if (Object.prototype.hasOwnProperty.call(clean, 'runtime')) {
    clean.runtime = validRuntimeSetting(clean.runtime);
  }
  return clean;
}

function validRuntimeSetting(value) {
  return (value === 'worker' || value === 'main') ? value : "";
}
```

Then at **both** assignment sites:

```js
    if (request.payload.settings) {
      update.settings = sanitizeSettings(request.payload.settings);
    }
```

```js
      if (request.payload.settings) {
        trinket.set('settings', sanitizeSettings(request.payload.settings));
      }
```

- [ ] **Step 5: Run the test — it should pass**

Same command as Step 2. Expected: 4 passed.

- [ ] **Step 6: Run the whole unit suite to prove nothing regressed**

Run: `docker run --rm -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app --platform linux/amd64 node:20-bullseye bash -lc 'npx vitest run'`
Expected: all green, count no lower than before your change.

- [ ] **Step 7: Commit**

```bash
git add lib/models/trinket.js lib/models/draft.js lib/controllers/trinket.js test/lib/api/trinketRuntimeSetting.test.js
git commit -m "feat(#128): store a runtime choice on the trinket, validated on write"
```

---

### Task 2: Router ordering, stored input, and notice text

**Files:**
- Modify: `public/js/embed/runtime-router.js`
- Test: `test/unit/runtime-router.test.js` (extend; existing cases must not change)

**Interfaces:**
- Consumes: nothing from Task 1 (the router is pure and takes the value as an option).
- Produces: `chooseRuntime(source, { usesVPython, workerEnabled, queryRuntime, storedRuntime })`; reasons `'trinket setting: runtime=worker'` and `'trinket setting: runtime=main'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/runtime-router.test.js`:

```js
// #128: a runtime stored on the trinket. Ordering matters more than any single
// rule here — see spec §3. The table below is the spec's worked-cases table.
describe('chooseRuntime with a stored trinket setting', () => {
  const LAMBDA = 'f = lambda: input()\nprint(f())';

  it('stored worker opts one trinket in on a flag-off deploy', () => {
    const r = chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'worker' });
    expect(r.runtime).toBe('worker');
    expect(r.reason).toMatch(/trinket setting/);
  });

  it('stored main opts one trinket out on a flag-on deploy', () => {
    const r = chooseRuntime('print(1)', { ...OPTS, workerEnabled: true, storedRuntime: 'main' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/trinket setting/);
  });

  it('the URL beats the stored value in both directions', () => {
    expect(chooseRuntime('print(1)', { ...OPTS, storedRuntime: 'worker', queryRuntime: 'main' }).runtime).toBe('main');
    expect(chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'main', queryRuntime: 'worker' }).runtime).toBe('worker');
  });

  it('VPython still beats a stored worker — the bridge cannot run off-thread', () => {
    const r = chooseRuntime('import vpython as vp', { ...OPTS, usesVPython: true, storedRuntime: 'worker' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/vpython/i);
  });

  it('THE D3 RULE: a stored worker does NOT override the unawaitable guard', () => {
    // A saved setting affects every student who opens the trinket, so it must
    // not be able to select a runtime that cannot run the program.
    const r = chooseRuntime(LAMBDA, { ...OPTS, storedRuntime: 'worker' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/lambda or comprehension/);
  });

  it('THE D3 RULE: a URL still may override the guard, for a false positive', () => {
    // The detector over-matches on purpose, so authors need this escape.
    expect(chooseRuntime(LAMBDA, { ...OPTS, queryRuntime: 'worker' }).runtime).toBe('worker');
  });

  it('an empty or unknown stored value is simply no preference', () => {
    expect(chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: '' }).runtime).toBe('main');
    expect(chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'nonsense' }).runtime).toBe('main');
  });
});

describe('runtimeNotice with a stored setting', () => {
  it('names the trinket setting as the reason, not the flag', () => {
    const d = chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'worker' });
    expect(runtimeNotice(d, undefined)).toMatch(/this trinket's setting/);
  });

  it('speaks for a stored main, which is otherwise an ordinary main-thread run', () => {
    const d = chooseRuntime('print(1)', { ...OPTS, workerEnabled: true, storedRuntime: 'main' });
    expect(runtimeNotice(d, undefined)).toMatch(/this trinket's setting/);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `docker run --rm -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app --platform linux/amd64 node:20-bullseye bash -lc 'npx vitest run test/unit/runtime-router.test.js'`
Expected: the new cases fail; **every pre-existing case still passes**.

- [ ] **Step 3: Reorder the rules and add the input**

Replace the body of `chooseRuntime` in `public/js/embed/runtime-router.js`:

```js
  // options: { usesVPython, workerEnabled, queryRuntime, storedRuntime }
  function chooseRuntime(source, options) {
    var opts = options || {};
    var stored = (opts.storedRuntime === 'worker' || opts.storedRuntime === 'main')
      ? opts.storedRuntime : '';

    // VPython first: its bridge does `from js import sphere, box, rate, …`,
    // binding synchronously to the window realm. No choice of any kind can
    // override that — off-thread it would simply fail to import.
    if (opts.usesVPython) {
      return { runtime: 'main', reason: 'vpython: bridge requires the window realm' };
    }

    // The URL is a deliberate, temporary act by whoever is holding it, and it
    // is allowed to override the guard below: the guard over-matches on purpose
    // (see hasUnawaitableCall), so an author needs an escape from a false
    // positive. #128 D3.
    if (opts.queryRuntime === 'main')   return { runtime: 'main',   reason: 'query: runtime=main' };
    if (opts.queryRuntime === 'worker') return { runtime: 'worker', reason: 'query: runtime=worker' };

    // A STORED setting must not be able to select a runtime that cannot run the
    // program — it affects every student who opens the trinket, permanently.
    // So the guard sits above it, and below the URL. #128 D3.
    if (hasUnawaitableCall(source)) {
      return { runtime: 'main', reason: 'await cannot be inserted in a lambda or comprehension' };
    }

    if (stored) {
      return { runtime: stored, reason: 'trinket setting: runtime=' + stored };
    }

    if (!opts.workerEnabled) {
      return { runtime: 'main', reason: 'config: worker runtime disabled' };
    }

    return { runtime: 'worker', reason: 'default' };
  }
```

- [ ] **Step 4: Teach the notice the new reasons**

In the same file, add to `NOTES`:

```js
    'trinket setting: runtime=worker'                       : "this trinket's setting",
    'trinket setting: runtime=main'                         : "this trinket's setting",
```

and extend `worthSaying` so a stored `main` speaks (it is otherwise indistinguishable from an ordinary quiet main-thread run):

```js
    var worthSaying = decision.runtime === 'worker'
                   || ignored
                   || decision.reason === 'await cannot be inserted in a lambda or comprehension'
                   || decision.reason.indexOf('trinket setting:') === 0;
```

- [ ] **Step 5: Run the router tests**

Same command as Step 2. Expected: all pass, **including every pre-existing case unedited**. If a pre-existing case needed changing, STOP — spec §3's behaviour-preserving claim is wrong and must be revisited.

- [ ] **Step 6: Commit**

```bash
git add public/js/embed/runtime-router.js test/unit/runtime-router.test.js
git commit -m "feat(#128): route on a stored trinket runtime, below the URL and the guard"
```

---

### Task 3: Feed the stored value into the router

**Files:**
- Modify: `public/js/embed/pyodide.js` (the `chooseRuntime` call site, ~:2243)
- Test: covered by Task 6's browser spec; no unit test (this is DOM wiring)

**Interfaces:**
- Consumes: `settings.runtime` from Task 1, `storedRuntime` option from Task 2.

- [ ] **Step 1: Read and whitelist the stored value**

At the call site in `public/js/embed/pyodide.js`, replace the `decision` block:

```js
  var queryRuntime = (api._queryString || {}).runtime;

  // #128: the trinket's own setting. Whitelisted here as well as on the server
  // (lib/controllers/trinket.js) because this value is client-supplied data that
  // also renders back into the settings modal — a value that predates or bypasses
  // server validation must degrade to "no preference", not reach the rules.
  var storedRuntime = '';
  try {
    var settings = (window.trinket && window.trinket.settings) || {};
    if (settings.runtime === 'worker' || settings.runtime === 'main') {
      storedRuntime = settings.runtime;
    }
  } catch (e) { storedRuntime = ''; }

  var decision = runtimeRouter.chooseRuntime(workerProgram, {
    usesVPython   : usesVPython(workerProgram),
    workerEnabled : !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime),
    queryRuntime  : queryRuntime,
    storedRuntime : storedRuntime
  });
```

- [x] **Step 2: Verify the value is actually reachable** — DONE, and the plan was wrong

`window.trinket` carries only `.config`, never `.settings`. Verified live in a
browser against a real trinket whose `settings.runtime` was `'worker'`:
`window.trinket.settings` was `undefined`; `window.TrinketApp._trinket.settings`
was `{ runtime: 'worker' }`.

**The real source is `api._trinket.settings`**, where `api` is `window.TrinketApp`
— the same access already used elsewhere in `pyodide.js` for
`api._trinket.description`. Task 6's browser tests should expect that.

- [ ] **Step 3: Commit**

```bash
git add public/js/embed/pyodide.js
git commit -m "feat(#128): pass the trinket's stored runtime to the router"
```

---

### Task 4: The settings-modal row

**Files:**
- Modify: `lib/views/includes/embed-settings.html`
- Modify: `public/js/embed/embed.js` (`settingsChange`, ~:2108; the delegated binding, ~:373)
- Test: Task 6's browser spec

**Interfaces:**
- Consumes: `config.app.runtimeOption`, `settings.runtime`.

- [ ] **Step 1: Teach `settingsChange` about a `<select>`**

This is the step that decides whether the control works at all. The handler is
bound to `input[data-trinket-settings]` and switches on input `type`; a
`<select>` is neither an `input` element nor any of the handled types, so
without this the row renders and silently never saves. There is a standing
`@TODO` in this function anticipating exactly this.

At ~:373 in `public/js/embed/embed.js`:

```js
    $(document).on('change', 'input[data-trinket-settings], select[data-trinket-settings]', $.proxy(this.settingsChange, this));
```

and in `settingsChange`, extend the type switch:

```js
      if (settingsType === "checkbox") {
        settingsValue = $(event.target).is(":checked");
      }
      else if (settingsType === "range" || settingsType === "hidden") {
        settingsValue = $(event.target).val();
      }
      // A <select> reports type "select-one". #128 added the first one.
      else if (settingsType === "select-one") {
        settingsValue = $(event.target).val();
      }
```

- [ ] **Step 2: Add the row**

In `lib/views/includes/embed-settings.html`, after the autofocus row and inside
the "Trinket Settings" section. Gated so it cannot appear where `?runtime=` does
nothing — the same shape as the `canEnableTests and canUseTests` gate above it:

```html
    {% if config.app.runtimeOption and config.app.runtimeOption.indexOf(trinket.lang) >= 0 %}
    <div class="row">
      <div class="small-12 columns">
        <h5 class="left">Runtime</h5>
        <select id="runtime" name="runtime" data-trinket-settings>
          <option value=""       {% if not ((draft and draft.settings.runtime) or (not draft and trinket.settings.runtime)) %}selected{% endif %}>Site default</option>
          <option value="worker" {% if (draft and draft.settings.runtime == 'worker') or (not draft and trinket.settings.runtime == 'worker') %}selected{% endif %}>Stoppable &mdash; recommended for programs with loops</option>
          <option value="main"   {% if (draft and draft.settings.runtime == 'main') or (not draft and trinket.settings.runtime == 'main') %}selected{% endif %}>Original &mdash; for a program the stoppable runtime can't run</option>
        </select>
      </div>
    </div>
    {% endif %}
```

Note the `id` must be `runtime`, because `settingsChange` keys the saved value by `event.target.id`.

- [ ] **Step 3: Manual check on the local stack**

Open a python3 trinket you own at `http://localhost:3001`, open Trinket Settings,
choose "Stoppable", save, reload. Expected: the selection persists, and the
console prints the stored-setting notice on the next run. Then open a
**glowscript** trinket: the row must not appear at all.

- [ ] **Step 4: Commit**

```bash
git add lib/views/includes/embed-settings.html public/js/embed/embed.js
git commit -m "feat(#128): offer the runtime choice in Trinket Settings"
```

---

### Task 5: Re-label the share dropdown as an override

**Files:**
- Modify: `lib/views/includes/shareModals.html` (the live dialog)
- Modify: `public/js/library/trinkets/detail/share.html` (the mirror)
- Test: `test/browser/specs/share-runtime-option.spec.js` (update assertions on label text only)

- [ ] **Step 1: Change the labels in the live dialog**

The mechanism does not change — only the words. "Use this site's default runtime"
is now wrong, because the link overrides a *trinket* setting, not the site default.

```html
                  <option value="">Use this trinket's setting</option>
                  <option value="worker">Stoppable &mdash; override for this link</option>
                  <option value="main">Original &mdash; override for this link</option>
```

- [ ] **Step 2: Make the identical change in the mirror**

In `public/js/library/trinkets/detail/share.html`, same three labels, keeping its
`shareRuntimeWorker` / `shareRuntimeMain` option values unchanged.

- [ ] **Step 3: Update any browser assertion that matches on the old text**

Run: `cd test/browser && npx playwright test specs/share-runtime-option.spec.js`
Fix only assertions that match the old label strings. Do not change what the
tests assert about behaviour.

- [ ] **Step 4: Commit**

```bash
git add lib/views/includes/shareModals.html public/js/library/trinkets/detail/share.html test/browser/specs/share-runtime-option.spec.js
git commit -m "feat(#128): the share dropdown now overrides the trinket's setting"
```

---

### Task 6: End-to-end coverage, both backends, and docs

**Files:**
- Test: `test/browser/specs/runtime-setting.spec.js` (new)
- Test: extend the Task 1 API test with a fork case
- Modify: `docs/DEPLOY-OVERLAY-GUIDE.md`

- [ ] **Step 1: Write the browser spec**

Create `test/browser/specs/runtime-setting.spec.js`, following the helper style of
`test/browser/specs/share-runtime-option.spec.js` (copy `createTrinket`,
`embedFrame`, `runInEmbed` verbatim rather than reinventing them):

```js
const { test, expect } = require('@playwright/test');

// #128: the runtime stored ON the trinket, as opposed to on a share link. The
// point of every test here is that NO query parameter is involved except where
// one is being tested explicitly.
test.describe('Per-trinket runtime setting (#128)', () => {
  // Copy createTrinket / embedFrame / runInEmbed verbatim from
  // specs/share-runtime-option.spec.js — same helpers, same harness.

  async function openSettings(page, lang, shortCode) {
    await page.goto('/embed/' + lang + '/' + shortCode);
    await page.locator('.ace_editor').first().waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('[data-interface="settings"], a:has-text("Settings")').first().click();
    await expect(page.locator('#settingsModal')).toBeVisible();
  }

  async function setRuntime(page, lang, shortCode, value) {
    await openSettings(page, lang, shortCode);
    await page.locator('#runtime').selectOption(value);
    // The change handler marks the trinket dirty; give the save a beat to land.
    await expect(async () => {
      const res = await page.request.get('/api/trinkets/' + shortCode);
      const body = await res.json();
      expect((body.data || body).settings.runtime).toBe(value);
    }).toPass({ timeout: 30_000 });
  }

  test('the row is offered for python3 and hidden for glowscript', async ({ page }) => {
    const py = await createTrinket(page, 'python3', 'print("settings row")');
    await openSettings(page, 'python3', py);
    await expect(page.locator('#runtime')).toBeVisible();

    const gs = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');
    await openSettings(page, 'glowscript', gs);
    // Hidden, not merely absent from view: the whole row must not render.
    await expect(page.locator('#runtime')).toHaveCount(0);
    // The modal itself rendered, proving the assertion above is about the gate.
    await expect(page.locator('#autofocusEnabled')).toBeVisible();
  });

  test('a stored setting routes the run with NO query parameter present', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("stored routing")');
    await setRuntime(page, 'python3', shortCode, 'worker');

    await page.goto('/embed/python3/' + shortCode);   // bare URL, no ?runtime=
    const frame = page;
    await frame.locator('.ace_editor').first().waitFor({ state: 'visible', timeout: 60_000 });
    await frame.locator('.run-it').first().click();
    await expect(async () => {
      expect(await frame.evaluate(() => window.__trinketRuntime)).toBeTruthy();
    }).toPass({ timeout: 120_000 });

    expect(await frame.evaluate(() => window.__trinketRuntime)).toBe('worker');
    // The REASON proves the stored setting did it, not the deploy flag.
    expect(await frame.evaluate(() => window.__trinketRuntimeReason)).toMatch(/trinket setting/);
  });

  test('a URL parameter still beats the stored setting', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("url wins")');
    await setRuntime(page, 'python3', shortCode, 'worker');

    await page.goto('/embed/python3/' + shortCode + '?runtime=main');
    await page.locator('.ace_editor').first().waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBeTruthy();
    }).toPass({ timeout: 120_000 });

    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
    expect(await page.evaluate(() => window.__trinketRuntimeReason)).toMatch(/query/i);
  });

  test('the setting survives a fork', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("fork me")');
    await setRuntime(page, 'python3', shortCode, 'worker');

    const res = await page.request.post('/api/trinkets/' + shortCode + '/fork');
    expect(res.ok(), 'fork should succeed').toBeTruthy();
    const forked = (await res.json()).data;

    const got = await page.request.get('/api/trinkets/' + forked.shortCode);
    expect(((await got.json()).data).settings.runtime).toBe('worker');
  });
});
```

If the fork endpoint's path or payload differs from the guess above, find the
real one (`config/routes.js`, search `fork`) and use it — the assertion is what
matters, not the route spelling. Every routing test asserts on
`window.__trinketRuntime` **and** `__trinketRuntimeReason`, so a pass proves
*why* the runtime was chosen, not merely which one.

- [ ] **Step 2: Prove the field round-trips on BOTH backends**

Extend `test/lib/api/trinketRuntimeSetting.test.js` with a fork case:

```js
  it('a fork inherits the stored runtime (spec D2)', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'worker' } });
    const forked = await forkTrinket(t.id);
    expect((await getTrinket(forked.id)).settings.runtime).toBe('worker');
  });
```

Then run the suite against **both** backends. A new nested field inside an
existing sub-document is exactly what has silently failed to round-trip on
Firestore before, so this is proved, not assumed. If the repo's Firestore leg is
run by a separate command or env var, find it in `test/` or `package.json` and
use it; record the exact command in your report.

- [ ] **Step 3: Document it**

In `docs/DEPLOY-OVERLAY-GUIDE.md`, in the `features.workerRuntime` section,
after the per-link paragraph:

```markdown
**Per-trinket setting:** an author can store a runtime on the trinket itself —
**Trinket Settings ▸ Runtime** — and it travels with the trinket: forks inherit
it, and every embed of it uses it, with no query parameter involved.

Precedence, highest first: a `?runtime=` on the URL, then the trinket's own
setting, then this flag. Two rules override all of them, because they are
capability limits rather than preferences: Web VPython always runs on the main
thread, and so does a program calling `input()`, `sleep()` or `rate()` inside a
lambda or comprehension. A `?runtime=worker` may override that second one — the
check deliberately over-matches — but a stored setting may not, so a saved
choice can never permanently break a trinket for everyone who opens it.
```

- [ ] **Step 4: Full suites**

Before running the browser suite, CONFIRM WHICH CHECKOUT THE LOCAL STACK SERVES:

```bash
docker inspect trinket-gcr --format '{{range .Mounts}}{{if eq .Destination "/usr/local/node/trinket"}}{{.Source}}{{end}}{{end}}'
```

It bind-mounts a checkout directory, which is NOT necessarily this worktree. It
has been pointed at this branch, but verify rather than assume — a browser suite
run against the wrong checkout passes or fails for reasons that have nothing to
do with your code.

Run the unit suite in the container and the browser suite against the local
stack. Both must be green, with counts no lower than before this plan started.

- [ ] **Step 5: Commit**

```bash
git add test/browser/specs/runtime-setting.spec.js test/lib/api/trinketRuntimeSetting.test.js docs/DEPLOY-OVERLAY-GUIDE.md
git commit -m "test(#128): end-to-end coverage for the stored runtime, and document it"
```
