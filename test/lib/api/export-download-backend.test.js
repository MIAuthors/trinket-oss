'use strict';

// A student-work export must be downloadable from the storage backend it was
// UPLOADED to.
//
// The upload half goes through lib/util/storage-backend (see
// lib/workers/exports.js: "this is the outlier, now brought into line"), which
// honours config.storage.backend. The download half did not: it built an AWS
// presigned URL unconditionally, so on every GCS deploy it signed against a
// bucket that exists only in Google Cloud Storage.
//
// Reported from UIndy production 2026-09-02, the first real use of the feature:
// clicking Download landed the instructor on https://aws.amazon.com/s3/ — the
// AWS marketing page. `https://s3.amazonaws.com/` 307-redirects there, so a
// signed URL that resolves to a bare S3 endpoint sends users to an ad. The
// archive itself was fine and sitting in gs://trinket-uindy-exports the whole
// time; only the link was wrong.
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const Export   = require('../../../lib/models/export');
const User     = require('../../../lib/models/user');

let backend, realSign;

beforeAll(() => {
  // The test config carries no exports bucket — the same gap that made the
  // real thing throw on Cloud Run until the overlays gained one.
  const config = require('config');
  config.aws = config.aws || {};
  config.aws.buckets = config.aws.buckets || {};
  config.aws.buckets.exports = config.aws.buckets.exports
    || { name: 'test-exports', host: 'https://example.invalid/test-exports' };

  // The controller resolves this lazily, so replacing the property on the
  // shared module object is what takes effect — same idiom as
  // course-export-submissions.test.js.
  backend = require('../../../lib/util/storage-backend');
  realSign = backend.signDownloadUrl;
});
afterAll(() => { backend.signDownloadUrl = realSign; });
beforeEach(async () => {
  flow.cookies = {};
  await flow.register();                     // registering also signs in
  userId = (await User.findOne({ email: defaults.user.email })).id;
});

let userId;

async function completedExportFor(ownerId) {
  // Same construction the controller uses (lib/controllers/users.js).
  const rec = new Export({
    _owner    : ownerId,
    status    : 'completed',
    s3Key     : 'exports/abc123/student-work-deadbeef.zip',
    expiresAt : new Date(Date.now() + 3600 * 1000),
  });
  return rec.save();
}

describe('downloading a student-work export', () => {
  it('signs the URL with the configured storage backend, not always AWS', async () => {
    // Stand in for a GCS deploy: the abstraction returns a Google-signed URL.
    const SIGNED = 'https://storage.googleapis.com/trinket-uindy-exports/'
                 + 'exports/abc123/student-work-deadbeef.zip?X-Goog-Signature=stub';
    let sawArgs = null;
    backend.signDownloadUrl = function(bucket, key, ttl) {
      sawArgs = { bucket, key, ttl };
      return Promise.resolve(SIGNED);
    };

    const rec = await completedExportFor(userId);
    const res = await flow.get(`/api/exports/${rec._id}/download`);

    expect(res.statusCode, 'the download should redirect to a signed URL').toBe(302);
    expect(sawArgs, 'the controller must go through lib/util/storage-backend')
      .not.toBeNull();
    expect(sawArgs.key).toBe('exports/abc123/student-work-deadbeef.zip');
    expect(res.headers.location).toBe(SIGNED);
  });

  it('never sends the user to the bare AWS endpoint', async () => {
    backend.signDownloadUrl = () => Promise.resolve(
      'https://storage.googleapis.com/b/k?X-Goog-Signature=stub');

    const rec = await completedExportFor(userId);
    const res = await flow.get(`/api/exports/${rec._id}/download`);
    const loc = res.headers.location || '';

    // https://s3.amazonaws.com/ 307s to https://aws.amazon.com/s3/ — the exact
    // UIndy symptom.
    expect(loc, 'a bare S3 endpoint redirects users to the AWS marketing page')
      .not.toMatch(/^https:\/\/s3\.amazonaws\.com\/?$/);
    expect(loc).toContain('storage.googleapis.com');
  });
});
