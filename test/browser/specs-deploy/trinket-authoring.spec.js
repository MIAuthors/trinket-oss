const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signInWithForm, apiFor, unwrap } = require('../deploy-auth');

// Authoring, against a real deployment: create a trinket, edit it, confirm the
// edit survived, then remix it.
//
// Remix is the flow every student uses to start from an instructor's code, and
// it is the one with a history of silent breakage — the anonymous edit→Share
// dead-MD5 bug shipped a fork that pointed at nothing. Creating and forking hit
// storage and the id/shortCode machinery, which a local stack fakes and a real
// deploy does not: this is why it runs here rather than in specs/.
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://... \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/trinket-authoring.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

const ORIGINAL = 'print("original ")';
const EDITED   = 'print("edited ")';

test.describe('trinket authoring', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  test('create, edit, persist, remix', async ({ page, baseURL }) => {
    const api = apiFor(page, baseURL);
    const runId = fixtures.runId();

    if (STATE) {
      const res = await page.goto('/home');
      expect(res.status()).toBeLessThan(400);
    } else {
      await signInWithForm(page, baseURL, EMAIL, PASSWORD);
    }

    // --- create -------------------------------------------------------------
    const created = await api('POST', '/api/trinkets',
      { code: ORIGINAL, lang: 'python3', name: runId + ' trinket' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const trinket = unwrap(created.body, 'trinket');
    const trinketId = trinket && (trinket.trinketId || trinket.id);
    expect(trinketId, 'a created trinket must come back with an id').toBeTruthy();

    // --- edit, and confirm it STUCK ------------------------------------------
    // Read it back rather than trusting the write's response: a save that
    // answers 200 and persists nothing is exactly the failure mode worth
    // catching, and it is invisible if the assertion reuses the write's echo.
    const edit = await api('PUT', `/api/trinkets/${trinketId}/code`, { code: EDITED });
    expect(edit.status, JSON.stringify(edit.body)).toBeLessThan(400);

    const reread = await api('GET', `/api/trinkets/${trinketId}`);
    expect(reread.status, JSON.stringify(reread.body)).toBe(200);
    expect(JSON.stringify(reread.body),
      'the edited code must survive a round trip').toContain('edited');

    // --- remix ---------------------------------------------------------------
    const fork = await api('POST', `/api/trinkets/${trinketId}/forks`,
      { code: EDITED, name: runId + ' remix' });
    expect(fork.status, 'remix must succeed: ' + JSON.stringify(fork.body)).toBe(200);
    const forked = unwrap(fork.body, 'trinket');
    const forkId = forked && (forked.trinketId || forked.id);
    expect(forkId, 'a remix must produce a real trinket id').toBeTruthy();
    expect(forkId, 'a remix must be a NEW trinket, not the original').not.toBe(trinketId);

    // The dead-fork bug: an id came back that resolved to nothing.
    const forkFetch = await api('GET', `/api/trinkets/${forkId}`);
    expect(forkFetch.status, 'the remix must actually resolve').toBe(200);
    expect(JSON.stringify(forkFetch.body),
      'the remix should carry the code it was forked from').toContain('edited');
  });
});
