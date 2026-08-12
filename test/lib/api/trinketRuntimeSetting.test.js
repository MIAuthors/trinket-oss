const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const Draft    = require('../../../lib/models/draft');
const User     = require('../../../lib/models/user');

// Reset the per-user cookie jar before each test — the 2a harness drops and
// recreates the DB per test, so any cached session would point at a dead user.
beforeEach(() => {
  flow.cookies = {};
});

// Local helpers over flow's raw verbs: flow.cjs has createTrinket() (fixed
// payload) and getTrinket() (HTML view by shortCode/lang), but no JSON
// create-with-overrides / update-settings / get-by-id trio. The autosave route
// (POST /api/trinkets/{id}/autosave) is the trinket-path assignment site named
// in the brief (lib/controllers/trinket.js ~1163) — it persists straight to
// the Trinket document, unlike the draft route, so a follow-up GET reflects it.
async function createTrinket(overrides) {
  await flow.post('/api/trinkets', defaults.extend(overrides || {}, 'trinket'));
  return flow.lastResponse.body.data;
}

async function updateTrinket(id, payload) {
  await flow.post('/api/trinkets/' + id + '/autosave', payload);
  return flow.lastResponse.body;
}

async function getTrinket(id) {
  await flow.get('/api/trinkets/' + id);
  return flow.lastResponse.body.data;
}

// config/api_routes.js: POST /api/trinkets/{trinketId}/forks trinket.createFork
// (spec D2). createFork builds `new Trinket(request.payload)` — it does NOT
// copy `settings` from the parent server-side, so unlike `lang` (always taken
// from the parent) inheritance is a CLIENT behavior: the real Fork button
// sends the parent's current settings in the payload (see python3.js's
// serialize(), which includes `settings: this._trinket.settings` alongside
// `code`). `code` is Joi-required on this route regardless of what's forked.
async function forkTrinket(id, payload) {
  await flow.post('/api/trinkets/' + id + '/forks', payload || {});
  return flow.lastResponse.body.data;
}

// The draft assignment site (lib/controllers/trinket.js's `draft` handler,
// Draft.findOneAndUpdate) is the whole reason sanitizeSettings exists: that
// path does NOT run mongoose validators, so the schema enum alone would not
// catch a bad value there. GET /api/trinkets/{id} reads the Trinket document,
// not the Draft collection, so it can't see this path — read the Draft back
// through the model instead, same as the controller does.
async function saveDraft(trinketId, payload) {
  await flow.post('/api/trinkets/' + trinketId + '/draft', payload);
  return flow.lastResponse.body;
}

async function getDraft(trinketId, userId) {
  return Draft.findOne({ trinket: trinketId, user: userId });
}

// #128: settings.runtime is client-supplied and reaches storage wholesale.
// The DRAFT path uses findOneAndUpdate, which does NOT run mongoose validators,
// so the schema enum alone does not constrain it. See spec §5.
describe('settings.runtime validation', () => {
  beforeEach(async () => {
    await flow.switchUser('user');
  });

  it('stores a valid value', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'worker' } });
    expect((await getTrinket(t.id)).settings.runtime).toBe('worker');
  });

  // NOTE: on this (.save()) site, mongoose's own schema validator is what
  // rejects these two writes, not sanitizeSettings — 'nonsense' fails the
  // enum and { $ne: null } fails the string cast, so .save() rejects the
  // whole document and nothing changes (GET still shows the prior ''). These
  // two are kept to document the enum's behavior, but they pass identically
  // with sanitizeSettings removed from the autosave call site — they are NOT
  // evidence the sanitizer does anything here. See "code survives an invalid
  // runtime" below for a test that actually discriminates on this site.
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

  // What sanitizeSettings actually buys on the .save() site: without it, an
  // invalid runtime makes mongoose reject the WHOLE document — any code (or
  // other field) bundled into the same autosave payload is lost along with
  // it. With it, runtime degrades to '' and the rest of the payload is saved.
  // This is the one that discriminates: remove sanitizeSettings from the
  // autosave branch and this fails (the code change never persists).
  it('sanitizes runtime without losing the rest of the payload', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, {
      code: 'print("distinctive-marker-128")',
      settings: { runtime: 'nonsense' },
    });
    const got = await getTrinket(t.id);
    expect(got.settings.runtime).toBe('');
    expect(got.code).toBe('print("distinctive-marker-128")');
  });

  it('leaves the other settings untouched', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'main', testsEnabled: true } });
    const got = (await getTrinket(t.id)).settings;
    expect(got.runtime).toBe('main');
    expect(got.testsEnabled).toBe(true);
  });

  // A fork inherits the stored runtime when the payload carries it — exactly
  // what the real Fork button sends (see forkTrinket's comment above). This is
  // the `/forks` route specifically: createFork takes a different code path
  // (`new Trinket(request.payload)`, no sanitizeSettings call) than the
  // autosave/.save() site the earlier tests in this file exercise, so a valid
  // value passing through it is not otherwise proven.
  it('a fork inherits the stored runtime (spec D2)', async () => {
    const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
    await updateTrinket(t.id, { settings: { runtime: 'worker' } });
    const parent = await getTrinket(t.id);

    const forked = await forkTrinket(t.id, { code: parent.code, settings: parent.settings });
    expect((await getTrinket(forked.id)).settings.runtime).toBe('worker');
  });

  // The DRAFT path specifically: Draft.findOneAndUpdate skips mongoose
  // validators, so unlike the .save() site above, the schema enum gives this
  // path no protection at all — sanitizeSettings is the only thing standing
  // between a bad value and storage here. Read back via the Draft model
  // directly, since GET /api/trinkets/{id} only ever sees the Trinket doc.
  describe('on the draft path (Draft.findOneAndUpdate, bypasses mongoose validators)', () => {
    let userId;

    beforeEach(async () => {
      userId = (await User.findOne({ email: defaults.user.email })).id;
    });

    it('stores a valid value', async () => {
      const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
      await saveDraft(t.id, { settings: { runtime: 'worker' } });
      expect((await getDraft(t.id, userId)).settings.runtime).toBe('worker');
    });

    it('rejects a value outside the enum, storing the empty default', async () => {
      const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
      await saveDraft(t.id, { settings: { runtime: 'nonsense' } });
      expect((await getDraft(t.id, userId)).settings.runtime).toBe('');
    });

    it('rejects a non-string just as firmly', async () => {
      const t = await createTrinket({ lang: 'python3', code: 'print(1)' });
      await saveDraft(t.id, { settings: { runtime: { $ne: null } } });
      expect((await getDraft(t.id, userId)).settings.runtime).toBe('');
    });
  });
});
