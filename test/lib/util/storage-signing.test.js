describe('storage signUploadUrl', () => {
  it('s3 backend returns a presigned PUT url string', async () => {
    // aws-sdk v2 getSignedUrl signs synchronously off static credentials.
    // The base test profile ships empty aws.key/keyId (config/default.yaml)
    // since no other suite exercises a real signing codepath — stub in fake
    // static credentials so the SigV2 signature step actually runs. Skipped
    // when garage has already wired up real ones (TEST_S3=garage, see
    // test/helpers/vitest-setup.cjs) so the round-trip test below keeps its
    // real credentials.
    const AWS = require('aws-sdk');
    if (!AWS.config.credentials || !AWS.config.credentials.accessKeyId) {
      AWS.config.update({ accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' });
    }
    const s3 = require('../../../lib/util/storage-backend-s3');
    const url = await s3.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(typeof url).toBe('string');
    expect(url).toMatch(/some-bucket/);
    expect(url).toMatch(/imports\/tmp\/u1\/abc\.zip/);
    expect(url).toMatch(/X-Amz-Expires=900|Expires=/);   // presigned params present
  });

  it.skipIf(!process.env.GCS_TEST)('gcs backend returns a v4 write url', async () => {
    const gcs = require('../../../lib/util/storage-backend-gcs');
    const url = await gcs.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(typeof url).toBe('string');
    expect(url).toMatch(/X-Goog-Algorithm|GoogleAccessId/);
  });

  it.skipIf(process.env.TEST_S3 !== 'garage')('FileUtil read/delete round-trip against garage', async () => {
    const FileUtil = require('../../../lib/util/file');
    const backend = require('../../../lib/util/storage-backend');
    const config = require('config');
    const key = 'imports/tmp/u1/roundtrip.zip';
    await new Promise((res, rej) => backend.upload(config.aws.buckets.materials.name, key, Buffer.from('zipbytes'), 'application/zip', (e) => e ? rej(e) : res()));
    const buf = await FileUtil.readImportObjectAsBuffer(key);
    expect(buf.toString()).toBe('zipbytes');
    await new Promise((res) => FileUtil.deleteImportObject(key, res));
  });
});
