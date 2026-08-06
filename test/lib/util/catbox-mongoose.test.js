// Session-store expiry.
//
// The bug this pins: the TTL index was declared on `stored`, which is a Number.
// mongod's TTL monitor only expires Date-typed fields and silently ignores
// numeric ones, so the index existed, matched every document, and deleted
// nothing. Asserting "an index exists" would have passed against that broken
// code -- so these tests assert the field's TYPE and, once, that a document
// actually disappears.
//
// Mongo-only: the Firestore backend has no syncIndexes/collection APIs, and the
// FS profile swaps this cache engine out for the in-memory one entirely.
const mongoose = require('mongoose');

const SESSIONS = () => mongoose.model('Session');

// mongod's TTL monitor runs on its own clock; poll instead of sleeping a fixed
// interval so the test is neither slow nor flaky.
async function waitForDeletion(id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await SESSIONS().countDocuments({ _id: id })) === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('catbox-mongoose session expiry', () => {
  let engine;

  beforeEach(async () => {
    const { Engine } = require('../../../lib/util/catbox-mongoose');
    engine = new Engine({});
    await engine.start();
    // The global afterEach drops the database, and dropping a database drops
    // its indexes. Rebuild from the schema so these assertions see a real
    // index set rather than whatever the previous test left behind.
    await SESSIONS().syncIndexes();
  });

  it('declares the TTL index on a Date field, not a Number', async () => {
    const indexes = await SESSIONS().collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl, 'no TTL index on the sessions collection at all').toBeTruthy();

    const field = Object.keys(ttl.key)[0];
    const path = SESSIONS().schema.path(field);
    expect(
      path && path.instance,
      `TTL index is on "${field}", a ${path && path.instance} — mongod only expires Date fields`
    ).toBe('Date');
  });

  it('stamps expiresAt as a Date when storing a session', async () => {
    const before = Date.now();
    await engine.set({ segment: 's', id: 'abc' }, { user: 1 }, 60000);

    const doc = await SESSIONS().findById('s:abc').lean();
    expect(doc, 'session was not stored').toBeTruthy();
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60000);
  });

  it('actually deletes an expired session', async () => {
    // Relies on ttlMonitorSleepSecs=1, set at mongod startup in
    // test/helpers/mongo-global.mjs. Setting it here instead would not work: the
    // parameter only takes effect after the monitor's current sleep, so the first
    // sweep would still be ~60s away.
    await SESSIONS().create({
      _id: 's:expired',
      value: {},
      stored: Date.now() - 120000,
      ttl: 60000,
      expiresAt: new Date(Date.now() - 60000)   // already past
    });

    const gone = await waitForDeletion('s:expired');
    expect(gone, 'mongod never deleted the expired session — the TTL index is not doing anything').toBe(true);
  });

  // Regression guards: behaviour that must survive the change. `get()` does
  // arithmetic on `stored` as a Number and hands it back to catbox, which is
  // why the fix adds a field rather than retyping `stored`.
  it('returns a live session unchanged', async () => {
    await engine.set({ segment: 's', id: 'live' }, { user: 1 }, 60000);
    const live = await engine.get({ segment: 's', id: 'live' });
    expect(live.item).toEqual({ user: 1 });
    expect(typeof live.stored).toBe('number');
    expect(live.ttl).toBe(60000);
  });

  it('drops an expired session on read without waiting for the TTL monitor', async () => {
    await engine.set({ segment: 's', id: 'dead' }, { user: 2 }, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await engine.get({ segment: 's', id: 'dead' })).toBeNull();
    expect(await SESSIONS().countDocuments({ _id: 's:dead' })).toBe(0);
  });
});

// Self-applying migration on start(). Merging the schema fix alone does NOT fix a
// running deployment: Mongoose's autoIndex adds the new expiresAt index but never
// drops the removed one, and sessions written before this field existed have no
// expiresAt for the TTL monitor to act on (picup prod: 494 of 797 already stale).
// So start() reconciles both, idempotently, so a deploy actually heals prod
// instead of leaving two manual steps in a PR body.
describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('catbox-mongoose boot migration', () => {
  let engine;

  beforeEach(async () => {
    const { Engine } = require('../../../lib/util/catbox-mongoose');
    engine = new Engine({});
    await engine.start();
    await SESSIONS().syncIndexes();
  });

  it('drops the stale numeric stored_1 TTL index left on production', async () => {
    // Reproduce prod: the old index (on a Number field, so it reaped nothing) is present.
    await SESSIONS().collection.createIndex({ stored: 1 }, { name: 'stored_1', expireAfterSeconds: 0 });
    expect((await SESSIONS().collection.indexes()).map((i) => i.name)).toContain('stored_1');

    await engine.start(); // boot migration reconciles indexes

    const names = (await SESSIONS().collection.indexes()).map((i) => i.name);
    expect(names, 'stale stored_1 index was not dropped').not.toContain('stored_1');
    expect(names, 'working expiresAt_1 index went missing').toContain('expiresAt_1');
  });

  it('is a no-op on the index when no stale stored_1 exists', async () => {
    // Idempotent: a clean deploy (or a second boot) must not error.
    await expect(engine.start()).resolves.not.toThrow();
    const names = (await SESSIONS().collection.indexes()).map((i) => i.name);
    expect(names).toContain('expiresAt_1');
  });

  it('backfills expiresAt on legacy ttl sessions so the monitor can reap them', async () => {
    const stored = Date.now() - 120000;
    await SESSIONS().collection.insertOne({ _id: 's:legacy', value: {}, stored, ttl: 60000 });

    await engine.start(); // boot migration backfills

    const doc = await SESSIONS().collection.findOne({ _id: 's:legacy' });
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.expiresAt.getTime()).toBe(stored + 60000);
  });

  it('never stamps expiresAt on a session without a ttl (must not be swept)', async () => {
    await SESSIONS().collection.insertOne({ _id: 's:permanent', value: {}, stored: Date.now() });

    await engine.start();

    const doc = await SESSIONS().collection.findOne({ _id: 's:permanent' });
    expect(doc.expiresAt == null, 'expiresAt was stamped on a ttl-less session').toBe(true);
  });

  it('lets the TTL monitor finally reap a backfilled legacy session end-to-end', async () => {
    await SESSIONS().collection.insertOne({
      _id: 's:legacy-expired', value: {}, stored: Date.now() - 120000, ttl: 60000
    });

    await engine.start(); // stamps expiresAt in the past

    const gone = await waitForDeletion('s:legacy-expired');
    expect(gone, 'backfilled legacy session was never reaped by the TTL monitor').toBe(true);
  });
});
