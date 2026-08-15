'use strict';

// Trinket-import ownership: the legacyShortCode dedup must be scoped PER
// IMPORTING USER. Found live on the merge trial (2026-07-06): a second user
// importing the same course zip got a course wired to the FIRST user's
// trinkets and owned nothing ("All my trinkets" empty). The import code's
// own comment states the intent: "Trinkets are owned by the importing user
// regardless of original ownership, making the import fully self-contained."

const JSZip = require('jszip');
const flow  = require('../../helpers/flow.cjs');

const CODE_A = 'print("original")';

function buildZip(code) {
  const zip = new JSZip();
  const sc  = 'abc123def0';
  zip.file('manifest.json', JSON.stringify({ trinkets: [{ shortCode: sc, lang: 'python3' }] }));
  const dir = 'python3/Imported_One_' + sc + '/';
  zip.file(dir + 'metadata.json', JSON.stringify({
    name: 'Imported One', description: 'from test zip', lang: 'python3'
  }));
  zip.file(dir + 'main.py', code || CODE_A);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function freshLogin(user) {
  delete flow.cookies[user];
  await flow.switchUser(user);
}

// trinket.io exports its Python type as lang:"python", but in trinket-oss
// "python" is the DISABLED Skulpt engine (features.trinkets.python=false) with
// no python3/pyodide alias — so imported python trinkets 404 on open ("This
// trinket type is not available"). trinket.io "python" is really Python-3 code
// (files start `#!/bin/python3`), so the importer must store it as the canonical
// python3 (Pyodide-backed, enabled), not the dead Skulpt "python".
function buildLangZip(lang, code) {
  const zip = new JSZip();
  const sc  = 'a1b2c3d4e5';
  zip.file('manifest.json', JSON.stringify({ trinkets: [{ shortCode: sc, lang: lang }] }));
  const dir = lang + '/Legacy_Py_' + sc + '/';
  zip.file(dir + 'metadata.json', JSON.stringify({ name: 'Legacy Py', description: 'legacy', lang: lang }));
  zip.file(dir + 'main.py', code || 'name = input("your name? ")\nprint(name)');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Trinket import — legacy trinket.io "python" lang normalization', () => {
  it('stores an imported lang:"python" trinket as python3, not the disabled Skulpt type', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python'));
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);

    await flow.get('/api/trinkets');
    const t = flow.lastResponse.body.data.find((x) => x.name === 'Legacy Py');
    expect(t).toBeTruthy();
    expect(t.lang).toBe('python3');          // pre-fix: 'python' -> 404 on open
  });

  it('leaves an already-canonical python3 import unchanged', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildLangZip('python3', 'print("hi")'));
    await flow.get('/api/trinkets');
    const t = flow.lastResponse.body.data.find((x) => x.name === 'Legacy Py');
    expect(t).toBeTruthy();
    expect(t.lang).toBe('python3');
  });

  it('flags a converted "python" trinket whose code uses Python-2 print syntax', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python', 'print "hello"'));
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);
    expect(r.body.data.python2Warnings).toContain('Legacy Py');   // user is told it needs updating
  });

  it('does NOT flag a converted "python" trinket that already uses print()', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python', 'print("hello")'));
    expect(r.body.data.python2Warnings || []).not.toContain('Legacy Py');
  });

  // Regression for the review finding: the Py2 heuristic used to match ONLY print
  // statements, so raw_input()/xrange()/except-comma converted to python3 silently
  // and broke at runtime with no warning. These pin the broadened detection —
  // each FAILS against the old print-only heuristic.
  it('flags Py2 raw_input() (renamed input() in py3)', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python', 'name = raw_input("? ")\nprint(name)'));
    expect(r.body.data.python2Warnings).toContain('Legacy Py');
  });

  it('flags Py2 xrange()', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python', 'for i in xrange(10):\n    print(i)'));
    expect(r.body.data.python2Warnings).toContain('Legacy Py');
  });

  it('flags Py2 `except Exc, e:` syntax', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python', 'try:\n    pass\nexcept Exception, e:\n    print(e)'));
    expect(r.body.data.python2Warnings).toContain('Legacy Py');
  });

  it('does NOT flag clean python3 (input(), range, except-as)', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildLangZip('python', 'try:\n    x = input()\nexcept Exception as e:\n    print(range(3))'));
    expect(r.body.data.python2Warnings || []).not.toContain('Legacy Py');
  });
});

describe('Trinket import ownership (legacyShortCode scoping)', () => {
  it('imports a fresh copy for the first user', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildZip());
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);

    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toContain('Imported One');
  });

  it('gives a SECOND importer their own copy instead of skipping', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip());

    await freshLogin('admin');
    const r = await flow.importTrinketsZip(await buildZip());
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);   // pre-fix: {imported: 0, skipped: 1}
    expect(r.body.data.skipped).toBe(0);

    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toContain('Imported One');
  });

  it('replace re-imports only touch the importer\'s own copy', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip(CODE_A));

    // Second user re-imports the same shortCode with DIFFERENT code + replace.
    await freshLogin('admin');
    await flow.importTrinketsZip(await buildZip('print("attacker")'), { replace: true });

    // First user's copy must be untouched (pre-fix: cross-user overwrite).
    // User/Trinket are app-boot model globals, same as the other API tests.
    const owner = await new Promise((res, rej) =>
      User.findByLogin('test@dummy.com', (e, d) => (e ? rej(e) : res(d))));
    const mine = await Trinket.findByOwner(owner._id || owner.id);
    const copy = mine.filter((t) => t.legacyShortCode === 'abc123def0')[0];
    expect(copy).toBeTruthy();
    expect(copy.code).toBe(CODE_A);
  });
});

// Deleting a trinket is a soft delete (deletedAt is stamped, the row stays with
// its legacyShortCode intact). The import dedup must therefore ignore deleted
// copies, or "delete everything and re-import" — the natural way to start over —
// silently restores nothing. Reported live on picup (2026-07-16): a user deleted
// all 80 trinkets, re-imported, and got "0 imported, 16 skipped".
describe('Trinket import after delete (soft-delete dedup)', () => {
  async function myCopies(shortCode) {
    const owner = await new Promise((res, rej) =>
      User.findByLogin('test@dummy.com', (e, d) => (e ? rej(e) : res(d))));
    const all = await Trinket.findByOwner(owner._id || owner.id);
    return all.filter((t) => t.legacyShortCode === shortCode);
  }

  it('re-imports a trinket the user has deleted', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip());

    await flow.get('/api/trinkets');
    const mine = flow.lastResponse.body.data.filter((t) => t.name === 'Imported One');
    expect(mine).toHaveLength(1);

    const del = await flow.del('/api/trinkets/' + (mine[0].id || mine[0]._id));
    expect(del.statusCode).toBe(200);

    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).not.toContain('Imported One');

    // The deleted copy must not count as "already imported".
    const r = await flow.importTrinketsZip(await buildZip());
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);   // pre-fix: {imported: 0, skipped: 1}
    expect(r.body.data.skipped).toBe(0);

    // ...and it comes back in the user's collection.
    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toContain('Imported One');
  });

  it('leaves the deleted copy deleted rather than resurrecting it', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip(CODE_A));

    await flow.get('/api/trinkets');
    const first = flow.lastResponse.body.data.filter((t) => t.name === 'Imported One')[0];
    await flow.del('/api/trinkets/' + (first.id || first._id));

    await flow.importTrinketsZip(await buildZip('print("second import")'));

    // A fresh row is created; the old one keeps its deletedAt stamp. Re-import is
    // not an undelete — the user asked for a clean copy, not their old one back.
    const copies = await myCopies('abc123def0');
    expect(copies).toHaveLength(1);
    expect(copies[0].code).toBe('print("second import")');
  });
});

// Review finding (Drew): imports.js assigns meta.settings — JSON.parsed straight
// out of a user-uploaded zip's metadata.json — to the Trinket doc without running
// it through sanitizeSettings(), on both the create path and the replace path.
// Firestore has no validators, so a bogus settings.runtime would land verbatim
// (an unmatched <option> the author can't clear). On Mongo the schema enum
// REJECTS it, so the whole .save() fails and the import errors out. Covers the
// Mongo half here: without the fix this whole trinket fails to import.
function buildSettingsZip(settingsPayload, code) {
  const zip = new JSZip();
  const sc  = 'set123abc0';
  zip.file('manifest.json', JSON.stringify({ trinkets: [{ shortCode: sc, lang: 'python3' }] }));
  const dir = 'python3/Settings_One_' + sc + '/';
  zip.file(dir + 'metadata.json', JSON.stringify({
    name: 'Settings One', description: 'settings sanitize test', lang: 'python3',
    settings: settingsPayload
  }));
  zip.file(dir + 'main.py', code || 'print("hi")');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Trinket import — settings sanitization (unvalidated write paths)', () => {
  it('sanitizes a bogus settings.runtime on the create path, without stripping sibling settings', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(
      await buildSettingsZip({ runtime: 'bogus', autofocusEnabled: false })
    );
    // Pre-fix on Mongo: the schema enum rejects 'bogus' and .save() fails,
    // so this trinket is silently dropped (not counted in `imported`).
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);
    expect(r.body.data.failed).toBe(0);

    await flow.get('/api/trinkets');
    const t = flow.lastResponse.body.data.find((x) => x.name === 'Settings One');
    expect(t).toBeTruthy();
    expect(t.settings.runtime).toBe('');               // sanitized, not 'bogus'
    expect(t.settings.autofocusEnabled).toBe(false);    // sibling survives sanitize
  });

  it('sanitizes a bogus settings.runtime on the replace (re-import) path', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildSettingsZip({ runtime: '', autofocusEnabled: true }));

    const r = await flow.importTrinketsZip(
      await buildSettingsZip({ runtime: 'bogus', autofocusEnabled: false }),
      { replace: true }
    );
    expect(r.statusCode).toBe(200);
    expect(r.body.data.failed || 0).toBe(0);

    await flow.get('/api/trinkets');
    const t = flow.lastResponse.body.data.find((x) => x.name === 'Settings One');
    expect(t).toBeTruthy();
    expect(t.settings.runtime).toBe('');
    expect(t.settings.autofocusEnabled).toBe(false);
  });
});
