'use strict';

// A counter with a window has to survive its own increments.
//
// recordFailedLogin did GET -> +1 -> SET, then EXPIRE only when the counter
// read 1. Redis SET **discards any existing TTL**, so from the second attempt
// the key lost its expiry and was never given another: the counter climbed
// forever and the account was locked out permanently. At maxPerAccount: 10 that
// is ten failed attempts across an account's entire lifetime — and because
// recordFailedLogin also fires for an unknown user, eleven unauthenticated
// POSTs against a known address lock that person out for good. (#248, reported
// by @drewsday against the PICUP VPS.)
//
// It is invisible everywhere we test. InMemoryClient.expire is a setTimeout
// that deletes the key, and `set` only reassigns the value — it never cancels
// that timer — so the in-memory path expires correctly no matter what the code
// does. Only a REDIS-backed deploy is affected. That is why these tests drive a
// fake with real Redis semantics rather than the in-memory client.
const Store = require('../../../lib/util/store');

// Minimal Redis semantics: SET clears TTL, INCR does not, EXPIRE sets one.
function fakeRedis() {
  const v = new Map(), ttl = new Map();
  return {
    calls: [],
    async get(k) { this.calls.push('get'); return v.has(k) ? String(v.get(k)) : null; },
    async set(k, val) { this.calls.push('set'); v.set(k, val); ttl.delete(k); return 'OK'; },
    async incr(k) { this.calls.push('incr'); const n = (Number(v.get(k)) || 0) + 1; v.set(k, n); return n; },
    async expire(k, s) { this.calls.push('expire'); ttl.set(k, s); return 1; },
    async del(k) { v.delete(k); ttl.delete(k); return 1; },
    ttlOf(k) { return ttl.has(k) ? ttl.get(k) : -1; },   // -1 = no expiry, as Redis reports
    valueOf(k) { return v.get(k); },
  };
}

describe('Store.bump — a windowed counter (#248)', () => {
  let fake;
  beforeEach(() => {
    fake = fakeRedis();
    vi.spyOn(Store, '_getClient').mockResolvedValue(fake);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the TTL across repeated increments', async () => {
    const k = 'rate:login:fail:acct:victim@example.com';
    for (let i = 1; i <= 5; i++) {
      const n = await Store.bump(k, 900);
      expect(n, 'bump should return the running count').toBe(i);
    }
    expect(fake.valueOf(k)).toBe(5);
    expect(fake.ttlOf(k),
      'the window must still be set after the 2nd..nth attempt — this is the bug: '
      + 'SET discards the TTL and EXPIRE was only called when the counter read 1')
      .toBe(900);
  });

  it('sets the window exactly once, on the first increment', async () => {
    const k = 'rate:login:fail:ip:203.0.113.9';
    for (let i = 0; i < 4; i++) await Store.bump(k, 900);
    const expires = fake.calls.filter((c) => c === 'expire').length;
    expect(expires, 'one EXPIRE, not one per attempt — resetting it every time '
      + 'would let a steady attacker hold the window open forever').toBe(1);
  });

  it('never uses SET, which is what clears the TTL', async () => {
    await Store.bump('rate:login:fail:acct:a@b.c', 900);
    await Store.bump('rate:login:fail:acct:a@b.c', 900);
    expect(fake.calls, 'INCR creates the key at 1 when absent and preserves any '
      + 'existing TTL; SET does neither').not.toContain('set');
  });

  it('is atomic per attempt — no read-modify-write to race', async () => {
    const k = 'rate:login:fail:ip:198.51.100.4';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Store.bump(k, 900)));
    expect(fake.valueOf(k), '20 concurrent attempts must count as 20').toBe(20);
    expect(new Set(results).size, 'each caller should see a distinct count').toBe(20);
  });
});
