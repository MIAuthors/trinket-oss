// Error-telemetry retention.
//
// errorevents is written on every client error (lib/controllers/trinket.js) with
// no expiry field and no cleanup path anywhere — the model header itself
// describes recording every encountered/repeated/resolved cycle per coding
// session, so it grows with student traffic and never shrinks.
//
// 400 days keeps a full academic year for year-over-year comparison while still
// bounding growth. No new field is needed: the timestamps plugin gives every
// model a `created` Date (lib/models/model.js), so the index applies to existing
// documents with no backfill.
//
// Mongo-only: the Firestore backend has no syncIndexes/collection APIs.
//
// NOTE: errorEvent.js reads config.constants.trinketLangs at module load, which
// is only populated once vitest-setup.cjs has booted the app in beforeAll. It
// must therefore be required lazily, not at this file's top level.
let ErrorEvent;

const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;   // 34,560,000 seconds

// Minimum viable ErrorEvent. `code` must be set explicitly despite declaring
// `default: ''` — mongoose's `required` rejects the empty string, so the default
// can never satisfy it.
function anEvent(overrides) {
  return Object.assign({
    state: 'encountered',
    session: 'sess-1',
    group: 1,
    error: 'NameError: name x is not defined',
    message: 'name x is not defined',
    code: 'print(x)',
    attempt: 0
  }, overrides || {});
}

describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('error telemetry retention', () => {
  beforeEach(async () => {
    ErrorEvent = require('../../../lib/models/errorEvent');
    // The global afterEach drops the database, and that drops indexes with it.
    await ErrorEvent.model.syncIndexes();
  });

  it('expires error events 400 days after created', async () => {
    const indexes = await ErrorEvent.model.collection.indexes();
    const ttl = indexes.find((i) => i.key && i.key.created === 1);
    expect(ttl, 'no TTL index on created').toBeTruthy();
    expect(ttl.expireAfterSeconds).toBe(FOUR_HUNDRED_DAYS);
  });

  it('keeps the existing compound query index', async () => {
    // errorEvent already declared an index before this change. The TTL entry
    // must extend that array, not replace it.
    const indexes = await ErrorEvent.model.collection.indexes();
    const compound = indexes.find(
      (i) => i.key && i.key.lang === 1 && i.key.state === 1 && i.key.type === 1 && i.key.session === 1
    );
    expect(compound, 'the pre-existing lang/state/type/session index was dropped').toBeTruthy();
  });

  it('keeps a recent error event', async () => {
    await ErrorEvent.model.create(anEvent({ created: new Date() }));
    // Give the TTL monitor (1s cycle in test) a chance to wrongly sweep it.
    await new Promise((r) => setTimeout(r, 2000));
    expect(await ErrorEvent.model.countDocuments({ session: 'sess-1' })).toBe(1);
  });

  it('actually deletes an error event older than the retention window', async () => {
    // Relies on ttlMonitorSleepSecs=1, set at mongod startup in
    // test/helpers/mongo-global.mjs.
    const longAgo = new Date(Date.now() - (401 * 24 * 60 * 60 * 1000));
    await ErrorEvent.model.create(anEvent({ session: 'sess-old', created: longAgo }));

    const deadline = Date.now() + 15000;
    let remaining = 1;
    while (Date.now() < deadline && remaining > 0) {
      remaining = await ErrorEvent.model.countDocuments({ session: 'sess-old' });
      if (remaining) await new Promise((r) => setTimeout(r, 250));
    }
    expect(remaining, 'mongod never deleted the aged error event — the TTL index is inert').toBe(0);
  });
});
