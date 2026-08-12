const flow = require('../../helpers/flow.cjs');

// Issue #6: importing/exporting "involves several clicks that can be hard to find
// if you don't know where to look." It was reachable only by digging into Account
// settings — a real user (trinketapp#26) exported all their trinkets from
// trinket.io and could not find any way to get them in, assuming the feature
// didn't exist.
//
// The fix surfaces "Import Trinkets" in the signed-in user menu, next to the
// existing "Connect LMS" entry. The link must be gated exactly like the route it
// points at (GET /account/import redirects users who fail userCanCreateCourse) —
// a nav link that silently bounces you to /account/profile is worse than none.
describe('import discoverability (#6)', () => {
  beforeEach(() => { flow.cookies = {}; });

  it('offers Import Trinkets in the menu for a signed-in user', async () => {
    await flow.switchUser('user');
    const res = await flow.get('/home');

    expect(res.statusCode).toBe(200);
    const html = String(res.payload || res.body || '');
    expect(html, 'the menu should link to the import page').toContain('/account/import');
    expect(html).toContain('Import Trinkets');
  });

  it('the link points at a page that actually serves (no redirect bounce)', async () => {
    // Guards the failure mode this fix is most likely to introduce: advertising a
    // link whose route gate then rejects the same user.
    await flow.switchUser('user');
    const res = await flow.get('/account/import');

    expect(res.statusCode, '/account/import should render, not redirect').toBe(200);
  });

  it('does not offer it to anonymous visitors', async () => {
    await flow.switchUser('');
    const res = await flow.get('/');

    const html = String(res.payload || res.body || '');
    expect(html).not.toContain('Import Trinkets');
  });

  it('exposes canImport to the client app for the My Trinkets toolbar', async () => {
    // The My Trinkets page is an Angular SPA with no server-side user context,
    // so its Import button reads this flag. It must be gated identically to the
    // route — a button that bounces the user to /account/profile is worse than
    // no button (issue #6).
    await flow.switchUser('user');
    const res = await flow.get('/library/trinkets');

    const html = String(res.payload || res.body || '');
    expect(html, 'the SPA config blob should carry canImport').toMatch(/canImport\s*:\s*(true|false)/);
  });

  it('reports canImport=false to anonymous visitors', async () => {
    await flow.switchUser('');
    const res = await flow.get('/');
    const html = String(res.payload || res.body || '');
    expect(html).toMatch(/canImport\s*:\s*false/);
  });
});
