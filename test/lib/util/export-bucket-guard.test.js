'use strict';

// An export must refuse when it has nowhere to put the archive — it must not
// take the server down.
//
// lib/workers/exports.js reads `config.aws.buckets.exports.name` directly. With
// no exports bucket configured that throws `Cannot read properties of undefined
// (reading 'name')`, and it throws inside the QUEUE HANDLER rather than inside a
// request. An unhandled exception there kills the node process: PM2 logs
// `process killed`, and Cloud Run answers the in-flight request with
// `503 malformed response` and restarts the container.
//
// Observed on rba-merge-trial 2026-09-03: three container deaths in ninety
// seconds, each one second after an export was requested, at 11% of 2 GiB — so
// not memory. deploys/trial-gcr simply has no exports bucket. uindy and mandi
// have one and export fine; uindy's overlay even carries a comment predicting
// this ("without this an export throws at the upload step").
//
// The failure mode is the point: one missing config key, and every user on that
// instance loses the server. exportGuard already exists to turn "this server
// cannot export" into a readable refusal — it just never covered this case.
const config = require('config');
const exportGuard = require('../../../lib/util/exportGuard');

describe('a deploy with no exports bucket', () => {
  let realBuckets;
  beforeEach(() => {
    realBuckets = config.aws.buckets;
    config.aws.buckets = Object.assign({}, realBuckets);
    delete config.aws.buckets.exports;
  });
  afterEach(() => { config.aws.buckets = realBuckets; });

  it('is reported as unable to export', () => {
    expect(exportGuard.exportsConfigured(),
      'no bucket means the archive has nowhere to go').toBe(false);
  });

  it('still reports configured when a bucket IS present', () => {
    config.aws.buckets.exports = { name: 'some-bucket', host: 'https://example.invalid/b' };
    expect(exportGuard.exportsConfigured()).toBe(true);
  });

  it('treats a bucket entry with no name as unconfigured', () => {
    config.aws.buckets.exports = { host: 'https://example.invalid/b' };
    expect(exportGuard.exportsConfigured(),
      'a nameless bucket throws in exactly the same place').toBe(false);
  });

  it('refuses with an explanation instead of throwing', async () => {
    const saved = [];
    const rec = { save: function() { saved.push(this); return Promise.resolve(this); } };
    const request = { fail: (body) => ({ refused: body }) };

    const out = await exportGuard.failIfUnavailable(null, rec, request);
    expect(out, 'an unconfigured deploy must refuse, not proceed').toBeTruthy();
    expect(rec.status).toBe('failed');
    expect(rec.errorMessage, 'the refusal must say what is wrong')
      .toMatch(/export/i);
    expect(saved.length, 'the refusal must be recorded on the export').toBe(1);
  });
});
