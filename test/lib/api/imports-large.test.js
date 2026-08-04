'use strict';

// Signed-URL minting for large course-archive imports (bypasses the 32 MiB
// Cloud Run ingress cap on direct POST — see FileUtil.isSignedUploadAvailable /
// FileUtil.signImportUploadUrl in lib/util/file.js). This route just mints the
// URL; it does not touch the import pipeline itself.

const config = require('config');
const flow   = require('../../helpers/flow.cjs');

async function currentUserId() {
  const doc = await new Promise((resolve, reject) =>
    User.findByLogin('test@dummy.com', (e, d) => (e ? reject(e) : resolve(d))));
  return String(doc.id || doc._id);
}

// The DB is dropped after every test (see vitest-setup.cjs afterEach), but
// flow's cookie jar is a module-level singleton that outlives it — a cached
// session cookie from an earlier test points at a user who no longer exists.
// Force a fresh login each time, same as imports.test.js's freshLogin().
async function freshLogin(user) {
  delete flow.cookies[user];
  await flow.switchUser(user);
}

describe('POST /api/imports/upload-url', () => {
  it('returns a signed URL + key + expiresAt for an authorized user', async () => {
    await freshLogin('user');
    const userId = await currentUserId();

    const r = await flow.post('/api/imports/upload-url');
    expect(r.statusCode).toBe(200);

    const data = r.body.data;
    expect(data.key).toMatch(new RegExp('^imports/tmp/' + userId + '/[A-Za-z0-9-]+\\.zip$'));
    expect(typeof data.url).toBe('string');

    const expiresAt = new Date(data.expiresAt);
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  describe('when large upload is disabled', () => {
    let origImports;
    beforeEach(() => { origImports = config.imports; });
    afterEach(() => { config.imports = origImports; });

    it('returns 501', async () => {
      config.imports = { largeUpload: { enabled: false } };
      await freshLogin('user');

      const r = await flow.post('/api/imports/upload-url');
      expect(r.statusCode).toBe(501);
    });
  });
});
