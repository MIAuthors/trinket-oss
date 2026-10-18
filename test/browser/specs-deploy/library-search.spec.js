const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap, assertOk } = require('../deploy-auth');

// Library search (#344), against a real deployment: the dropdown's count
// footer, "See all" reaching a description-only match that isn't in the first
// 20, and clearing the search chip. The course-editor toolbar's insert search
// is covered end-to-end by editor-embed-host.spec.js; run both.
//
// TRIALS ONLY (no test identities in prod). Creates 22 trinkets tagged with the
// run id and deletes them at the end.
//
//   SMOKE_STORAGE_STATE=... TRINKET_BASE_URL=https://<trial> \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/library-search.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

test.describe('library search', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  const ids = [];
  let api;

  test.beforeEach(async ({ page, baseURL }) => {
    api = apiFor(page, baseURL);
    if (STATE) {
      const res = await page.goto('/home');
      expect(res.status(), 'captured session should still be valid').toBeLessThan(400);
    } else {
      await signIn(page, baseURL, EMAIL, PASSWORD);
    }
  });

  test('count footer, See all, and the search chip', async ({ page }) => {
    // A term no real trinket contains: letters and digits only, lower case.
    const tag = 'ls' + fixtures.runId().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-10);

    // 21 name matches + 1 description-only match = 22, more than the 20 shown.
    for (let i = 0; i < 21; i++) {
      const res = await api('POST', '/api/trinkets',
        { code: 'pass\n', lang: 'python3', name: tag + ' ' + String(i).padStart(2, '0') });
      assertOk(expect, res, 'creating trinket ' + i);
      const t = unwrap(res.body, 'trinket');
      ids.push(t.trinketId || t.id);
    }
    const notes = await api('POST', '/api/trinkets', { code: 'pass\n', lang: 'python3', name: tag.toUpperCase().slice(0, 2) + ' notes' });
    assertOk(expect, notes, 'creating the description-only trinket');
    const notesT = unwrap(notes.body, 'trinket');
    const notesId = notesT.trinketId || notesT.id;
    ids.push(notesId);
    assertOk(expect, await api('PUT', `/api/trinkets/${notesId}/description`, { description: 'see ' + tag }),
      'setting its description');

    // The API first: the total the footer will show.
    const s = await api('GET', '/api/trinkets/search?q=' + tag);
    expect(s.body.total, JSON.stringify(s.body).slice(0, 300)).toBe(22);
    expect(s.body.data).toHaveLength(20);

    // --- the dropdown --------------------------------------------------------
    await page.goto('/library');
    const label = page.locator('#search-label');
    await label.waitFor({ state: 'visible', timeout: 30000 });
    await label.click();
    const input = page.locator('#trinket-search');
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.fill(tag);

    const footer = page.locator('.trinket-search-footer');
    await expect(footer).toContainText('Showing 20 of 22, best matches first', { timeout: 30000 });
    await expect(footer).toContainText('See all 22 results');

    // --- See all → the paged list --------------------------------------------
    await footer.click();
    const chip = page.locator('.library-search-chip');
    await expect(chip).toContainText(tag, { timeout: 15000 });
    await expect(chip).toContainText('(name or instructions)');

    // The description-only match ranks last (22nd), so it only appears once
    // the list pages past the first 20. Scroll until it does.
    const notesCard = page.getByText(/ notes$/).first();
    for (let i = 0; i < 10 && !(await notesCard.isVisible()); i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(800);
    }
    await expect(notesCard).toBeVisible();

    // --- open a result, come Back: still the same search ----------------------
    await notesCard.click();
    await page.waitForURL((u) => !/\/library\/?$/.test(u.pathname), { timeout: 15000 });
    await page.goBack();
    await expect(chip).toContainText(tag, { timeout: 15000 });

    // --- clearing the chip ---------------------------------------------------
    await chip.locator('a').click();
    await expect(chip).toHaveCount(0);
  });

  test.afterEach(async () => {
    if (ids.length) {
      await api('POST', '/api/trinkets/bulk', { action: 'delete', ids: ids.splice(0) }).catch(() => {});
    }
  });
});
