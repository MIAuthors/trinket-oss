'use strict';

// Rate limiting means something different on each backing store, and the
// difference should not be silent.
//
// #248 was a Redis bug: SET cleared the TTL, so lockouts became permanent. The
// in-memory path never had it — `set` there does not cancel the expiry timer.
// But in-memory has the OPPOSITE weakness, and nothing says so anywhere:
// memoryCache is a module-level object, so counters are PER PROCESS. Our Cloud
// Run services run maxScale: 10, so in the worst case there are ten independent
// counters and the effective limit is 10x the configured one; instances also
// scale to zero, resetting counters on every cold start.
//
// Neither property is wrong, exactly — a per-instance limiter still blunts a
// single-source attack. What is wrong is that `maxPerAccount: 10` reads like a
// guarantee and is not one. So the startup check states the scope out loud, the
// same way it already states which DB and session store are in use.
const startup = require('../../../lib/util/startup-check');

describe('startup check reports rate-limit scope', () => {
  it('exposes a helper that describes the limiter scope', () => {
    expect(typeof startup.rateLimitScope,
      'startup-check should be able to describe the limiter, not just the DB')
      .toBe('function');
  });

  it('calls a Redis-backed limiter shared across instances', () => {
    const line = startup.rateLimitScope({ db: { redis: { enabled: true } } });
    expect(line).toMatch(/redis/i);
    expect(line).toMatch(/shared/i);
  });

  it('says plainly that an in-memory limiter is per instance', () => {
    const line = startup.rateLimitScope({ db: { redis: { enabled: false } } });
    expect(line).toMatch(/in-memory/i);
    expect(line, 'an operator reading maxPerAccount: 10 should learn here that '
      + 'the real ceiling is that many PER INSTANCE').toMatch(/per.instance/i);
  });

  it('treats a missing redis block as in-memory, not as shared', () => {
    // Fail toward the weaker claim: absent config must not read as "shared".
    const line = startup.rateLimitScope({});
    expect(line).toMatch(/in-memory/i);
  });
});
