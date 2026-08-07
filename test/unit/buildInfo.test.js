const buildInfo = require('../../lib/util/buildInfo');

// The values behind GET /version. Env vars win over the baked build-info.json
// so a running container can be corrected without a rebuild.
describe('buildInfo', () => {
  const saved = {};
  const KEYS = ['COMMIT_ID', 'GIT_BRANCH', 'BUILD_TIME', 'TRINKET_DEPLOY'];

  beforeEach(() => { KEYS.forEach((k) => { saved[k] = process.env[k]; }); });
  afterEach(() => {
    KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  it('reports the commit from the environment, short and full', () => {
    process.env.COMMIT_ID = 'b9c443e02504c6ee1d0b9796d57c8fc40a0666a5';
    const info = buildInfo.publicInfo();
    expect(info.commitFull).toBe('b9c443e02504c6ee1d0b9796d57c8fc40a0666a5');
    expect(info.commit).toBe('b9c443e');
  });

  it('passes through branch, build time and deploy name', () => {
    process.env.GIT_BRANCH     = 'trial/convergence';
    process.env.BUILD_TIME     = '2026-08-07T01:12:03Z';
    process.env.TRINKET_DEPLOY = 'uindy';
    const info = buildInfo.publicInfo();
    expect(info.branch).toBe('trial/convergence');
    expect(info.builtAt).toBe('2026-08-07T01:12:03Z');
    expect(info.deploy).toBe('uindy');
  });

  it('treats an empty env var as absent', () => {
    // Cloud Build can't pass --build-arg through `gcloud builds submit --tag`,
    // so the image's ENV COMMIT_ID is the empty string. That must NOT mask the
    // build-info.json fallback (or report a bogus empty commit).
    process.env.COMMIT_ID = '';
    expect(buildInfo.publicInfo().commit).not.toBe('');
  });

  it('never throws when nothing is stamped', () => {
    KEYS.forEach((k) => { delete process.env[k]; });
    const info = buildInfo.publicInfo();
    expect(typeof info.commit).toBe('string');   // 'unknown' or the baked file's value
    expect(typeof info.version).toBe('string');
    expect(info.deploy).toBe('default');
  });

  it('keeps the infrastructure profile out of the public payload', () => {
    const pub = buildInfo.publicInfo();
    expect(pub.backend).toBeUndefined();
    expect(pub.uptime).toBeUndefined();

    const extras = buildInfo.adminExtras();
    expect(typeof extras.backend).toBe('string');
    expect(typeof extras.uptime).toBe('number');
  });
});
