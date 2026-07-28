// LTI nonce storage: indexing and expiry.
//
// Two defects are pinned here. The collection grew forever (the TTL policy the
// model's comment described was never configured anywhere, and no code path
// deletes a nonce), and `nonce` was unindexed while findByNonce queries it on
// every single launch — a collection scan that got slower as the leak grew.
//
// Mongo-only: the Firestore backend exposes no syncIndexes/collection APIs, and
// Firestore single-field-indexes everything automatically, so neither assertion
// is meaningful there.
const LtiNonce = require('../../../lib/models/ltiNonce');
const ltiNonceStore = require('../../../lib/util/ltiNonceStore');

async function waitForDeletion(nonce, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await LtiNonce.model.countDocuments({ nonce })) === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('LtiNonce', () => {
  beforeEach(async () => {
    // The global afterEach drops the database, and that drops indexes with it.
    await LtiNonce.model.syncIndexes();
  });

  describe('indexes', () => {
    it('declares a TTL index on expiresAt', async () => {
      const indexes = await LtiNonce.model.collection.indexes();
      const ttl = indexes.find((i) => i.key && i.key.expiresAt === 1);
      expect(ttl, 'no index on expiresAt').toBeTruthy();
      expect(ttl.expireAfterSeconds).toBe(0);
    });

    it('indexes nonce, which findByNonce queries on every launch', async () => {
      const indexes = await LtiNonce.model.collection.indexes();
      expect(
        indexes.some((i) => i.key && i.key.nonce === 1),
        'nonce is unindexed — findByNonce is a collection scan per LTI launch'
      ).toBe(true);
    });

    it('actually deletes an expired nonce', async () => {
      // Relies on ttlMonitorSleepSecs=1, set at mongod startup in
      // test/helpers/mongo-global.mjs.
      await LtiNonce.model.create({ nonce: 'expired-one', expiresAt: new Date(Date.now() - 1000) });
      const gone = await waitForDeletion('expired-one');
      expect(gone, 'mongod never deleted the expired nonce — the TTL index is inert').toBe(true);
    });
  });

  describe('replay protection', () => {
    it('accepts a fresh nonce and rejects the same one twice', async () => {
      expect(await ltiNonceStore.checkAndRecord('fresh-1', 600)).toBe(true);
      expect(await ltiNonceStore.checkAndRecord('fresh-1', 600)).toBe(false);
    });

    // This is the safety argument for shrinking the ledger from permanent to
    // ~10 minutes: checkAndRecord rejects on EXISTENCE and never reads
    // expiresAt, so a nonce that is past expiry but not yet swept still blocks a
    // replay. If this ever starts failing, the TTL change has become unsafe.
    it('rejects a replay even when the nonce is already past its expiry', async () => {
      expect(await ltiNonceStore.checkAndRecord('stale-1', 600)).toBe(true);
      await LtiNonce.model.updateOne(
        { nonce: 'stale-1' },
        { $set: { expiresAt: new Date(Date.now() - 60000) } }
      );
      expect(await ltiNonceStore.checkAndRecord('stale-1', 600)).toBe(false);
    });

    it('records an expiry in the future for a fresh nonce', async () => {
      const before = Date.now();
      await ltiNonceStore.checkAndRecord('fresh-2', 600);
      const doc = await LtiNonce.model.findOne({ nonce: 'fresh-2' }).lean();
      expect(doc.expiresAt).toBeInstanceOf(Date);
      expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600 * 1000);
    });
  });

  it('still finds a recorded nonce by value', async () => {
    await new LtiNonce({ nonce: 'abc123', expiresAt: new Date(Date.now() + 600000) }).save();
    const found = await LtiNonce.findByNonce('abc123');
    expect(found).toBeTruthy();
    expect(found.nonce).toBe('abc123');
  });
});
