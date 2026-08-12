const { test, expect } = require('@playwright/test');

// #128: the runtime stored ON the trinket, as opposed to on a share link. The
// point of every test here is that NO query parameter is involved except where
// one is being tested explicitly.
test.describe('Per-trinket runtime setting (#128)', () => {
  // createTrinket copied verbatim from specs/share-runtime-option.spec.js.
  async function createTrinket(page, lang, code) {
    const res = await page.request.post('/api/trinkets', {
      data: { lang, code, name: 'runtime-setting-' + lang + '-' + Date.now() },
    });
    expect(res.ok(), 'trinket create should succeed').toBeTruthy();
    const body = await res.json();
    return (body.data || body).shortCode;
  }

  // Opens Trinket Settings on the embed page itself (not the trinket/library
  // page share-runtime-option.spec.js uses). `shortCode` is optional: with none,
  // this lands on a brand-new, unsaved trinket at /embed/<lang> — the exact
  // state that made Task 4's first attempt (gated on `trinket.lang`, undefined
  // pre-save) silently drop the row.
  //
  // The Settings link lives inside the left off-canvas menu (lib/views/embed/
  // left-menu.html, data-action="code.settings"), which is closed by default —
  // opening it via .left-off-canvas-toggle is required before the link is
  // clickable. Confirmed against the live stack; the modal itself won't open
  // without this step.
  async function openSettings(page, lang, shortCode) {
    await page.goto('/embed/' + lang + (shortCode ? '/' + shortCode : ''));
    await page.locator('.ace_editor').first().waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('.left-off-canvas-toggle').first().click();
    await page.locator('a[data-action="code.settings"]').first().click();
    await expect(page.locator('#settingsModal')).toBeVisible();
  }

  // Setting #runtime in the modal only saves to the author's Draft (POST
  // .../draft) — confirmed live: GET /api/trinkets/{id} still reads the prior
  // value at that point. It only lands on the Trinket document itself (visible
  // to every other viewer, and to a fork) once the explicit Save control is
  // clicked: a.create-remix.save-it, which PUTs /api/trinkets/{id}/code. Both
  // steps are required for a change here to be the persisted, shared setting
  // the doc promises ("every embed of it uses it").
  async function setRuntime(page, lang, shortCode, value) {
    await openSettings(page, lang, shortCode);
    await page.locator('#runtime').selectOption(value);

    // Close the modal — its overlay blocks the Save control underneath.
    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsModal')).toBeHidden();

    const saveBtn = page.locator('a.create-remix.save-it');
    await expect(saveBtn, 'the settings change must enable Save').not.toHaveClass(/disabled/);
    await saveBtn.click();

    await expect(async () => {
      const res = await page.request.get('/api/trinkets/' + shortCode);
      const body = await res.json();
      expect((body.data || body).settings.runtime).toBe(value);
    }).toPass({ timeout: 30_000 });
  }

  test('the row is offered for python3 and hidden for glowscript (saved trinkets)', async ({ page }) => {
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

  // The case that broke in Task 4: gating the row on `trinket.lang` (undefined
  // before the first save) instead of the page's own `lang` made it vanish
  // exactly when an author is writing the program that would need it. No
  // shortCode here at all — /embed/python3 and /embed/glowscript with nothing
  // ever saved.
  test('the row renders on a brand-new, unsaved python3 trinket and is absent on glowscript', async ({ page }) => {
    await openSettings(page, 'python3', null);
    await expect(page.locator('#runtime')).toBeVisible();

    await openSettings(page, 'glowscript', null);
    await expect(page.locator('#runtime')).toHaveCount(0);
    await expect(page.locator('#autofocusEnabled')).toBeVisible();
  });

  test('a stored setting routes the run with NO query parameter present', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("stored routing")');
    await setRuntime(page, 'python3', shortCode, 'worker');

    await page.goto('/embed/python3/' + shortCode);   // bare URL, no ?runtime=
    await page.locator('.ace_editor').first().waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBeTruthy();
    }).toPass({ timeout: 120_000 });

    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
    // The REASON proves the stored setting did it, not the deploy flag.
    expect(await page.evaluate(() => window.__trinketRuntimeReason)).toMatch(/trinket setting/);
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

  // config/api_routes.js: POST /api/trinkets/{trinketId}/forks trinket.createFork
  // (the brief guessed .../fork, singular — the real route is plural and takes
  // the trinket's id, not its shortCode, as {trinketId}, though the `trinket()`
  // pre-handler's alternateIds also accept the shortCode — see lib/models/
  // trinket.js `alternateIds: ['shortCode']`). createFork builds `new
  // Trinket(request.payload)` with no server-side copy of the parent's
  // `settings` — inheritance is a CLIENT behavior: python3.js's serialize()
  // (public/js/embed/python3.js) includes `settings: this._trinket.settings`
  // in every fork payload, same as `code`. So the payload below (code +
  // settings) mirrors exactly what a real Fork click sends; `code` is
  // Joi-required on this route regardless.
  test('the setting survives a fork', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("fork me")');
    await setRuntime(page, 'python3', shortCode, 'worker');

    const parentRes = await page.request.get('/api/trinkets/' + shortCode);
    const parent = (await parentRes.json()).data;

    const res = await page.request.post('/api/trinkets/' + parent.id + '/forks', {
      data: { code: parent.code, settings: parent.settings },
    });
    expect(res.ok(), 'fork should succeed').toBeTruthy();
    const forked = (await res.json()).data;

    const got = await page.request.get('/api/trinkets/' + forked.shortCode);
    expect(((await got.json()).data).settings.runtime).toBe('worker');
  });
});
