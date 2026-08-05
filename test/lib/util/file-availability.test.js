const config = require('config');

describe('FileUtil.isSignedUploadAvailable', () => {
  let FileUtil, orig;
  beforeEach(() => {
    FileUtil = require('../../../lib/util/file');
    orig = { imports: config.imports, backend: config.storage && config.storage.backend };
  });
  afterEach(() => {
    config.imports = orig.imports;
    if (config.storage) config.storage.backend = orig.backend;
  });

  it('is true when enabled and backend is s3', () => {
    config.imports = { largeUpload: { enabled: true } };
    config.storage.backend = 's3';
    expect(FileUtil.isSignedUploadAvailable()).toBe(true);
  });
  it('is true when enabled and backend is gcs', () => {
    config.imports = { largeUpload: { enabled: true } };
    config.storage.backend = 'gcs';
    expect(FileUtil.isSignedUploadAvailable()).toBe(true);
  });
  it('is false when enabled is false even with storage configured', () => {
    config.imports = { largeUpload: { enabled: false } };
    config.storage.backend = 's3';
    expect(FileUtil.isSignedUploadAvailable()).toBe(false);
  });
  it('is false when the imports config is absent', () => {
    config.imports = undefined;
    config.storage.backend = 's3';
    expect(FileUtil.isSignedUploadAvailable()).toBe(false);
  });
});
