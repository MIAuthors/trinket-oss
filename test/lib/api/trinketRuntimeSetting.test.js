const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

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
