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

// The commit the running code is at. A compose deploy bind-mounts the checkout
// over the image, so build-info.json and COMMIT_ID describe the image while the
// checkout describes what is actually being served. These read .git by hand;
// fixtures rather than the live repo, so the suite behaves the same inside the
// test container (which has no usable .git).
describe('buildInfo.gitHeadFrom', () => {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');

  let root;
  const mk = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const SHA = 'd16a0b547178681eb956dd779bd3dc2c8ebbf2fc';

  it('resolves a branch through its loose ref', () => {
    mk('.git/HEAD', 'ref: refs/heads/trial/convergence\n');
    mk('.git/refs/heads/trial/convergence', SHA + '\n');
    expect(buildInfo.gitHeadFrom(root)).toEqual({ commit: SHA, branch: 'trial/convergence' });
  });

  it('resolves a detached HEAD, which is how the deploy worktrees run', () => {
    mk('.git/HEAD', SHA + '\n');
    expect(buildInfo.gitHeadFrom(root)).toEqual({ commit: SHA, branch: null });
  });

  it('falls back to packed-refs when there is no loose ref', () => {
    mk('.git/HEAD', 'ref: refs/heads/main\n');
    mk('.git/packed-refs', '# pack-refs with: peeled fully-peeled sorted \n' +
                           SHA + ' refs/heads/main\n');
    expect(buildInfo.gitHeadFrom(root).commit).toBe(SHA);
  });

  it('follows a linked worktree: .git is a FILE, and refs live in commondir', () => {
    // The deploy checkouts are worktrees. Resolving refs against the worktree's
    // own dir instead of the common dir finds nothing for anything on a branch.
    const common = path.join(root, 'main-repo', '.git');
    fs.mkdirSync(path.join(common, 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(path.join(common, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(common, 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/deploy-mandi\n');
    fs.writeFileSync(path.join(common, 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.writeFileSync(path.join(common, 'refs', 'heads', 'deploy-mandi'), SHA + '\n');
    mk('.git', 'gitdir: ' + path.join(common, 'worktrees', 'wt') + '\n');

    expect(buildInfo.gitHeadFrom(root)).toEqual({ commit: SHA, branch: 'deploy-mandi' });
  });

  it('returns null when there is no checkout — the Cloud Run image case', () => {
    expect(buildInfo.gitHeadFrom(root)).toBeNull();
  });

  it('does not throw on a malformed HEAD', () => {
    mk('.git/HEAD', 'not a ref at all\n');
    expect(buildInfo.gitHeadFrom(root)).toBeNull();
  });

  it('reports the branch even when its ref cannot be resolved', () => {
    mk('.git/HEAD', 'ref: refs/heads/orphan\n');
    expect(buildInfo.gitHeadFrom(root)).toEqual({ commit: null, branch: 'orphan' });
  });
});

describe('buildInfo.publicInfo commit precedence', () => {
  it('still lets COMMIT_ID win, so a container can be corrected without a rebuild', () => {
    process.env.COMMIT_ID = 'b9c443e02504c6ee1d0b9796d57c8fc40a0666a5';
    const info = buildInfo.publicInfo();
    expect(info.commitFull).toBe('b9c443e02504c6ee1d0b9796d57c8fc40a0666a5');
    expect(info.commitSource).toBe('env');
    delete process.env.COMMIT_ID;
  });

  // Found by smoke-testing the real endpoint: a DETACHED checkout (how the
  // deploy worktrees run) has no branch, so the old fallback reported the branch
  // of a different, older commit beside a correct fresh one.
  describe('branch never comes from a different source than the commit', () => {
    const SHA = 'ec1732d1db27260b6fe8709dccc8038d2bcf490f';

    it('uses the checkout branch when the checkout supplies the commit', () => {
      expect(buildInfo.resolveBranch(null, { commit: SHA, branch: 'trial/convergence' }, 'stale-branch'))
        .toBe('trial/convergence');
    });

    it("says 'detached' rather than borrowing the build file's branch", () => {
      expect(buildInfo.resolveBranch(null, { commit: SHA, branch: null }, 'spike/109-pyodide-repl'))
        .toBe('detached');
    });

    it('falls back to the build file only when there is no checkout', () => {
      expect(buildInfo.resolveBranch(null, null, 'deploy-mandi')).toBe('deploy-mandi');
    });

    it('lets GIT_BRANCH win, matching the commit precedence', () => {
      expect(buildInfo.resolveBranch('override', { commit: SHA, branch: 'x' }, 'y')).toBe('override');
    });

    it('degrades to unknown with nothing to go on', () => {
      expect(buildInfo.resolveBranch(null, null, null)).toBe('unknown');
    });
  });

  it('names where the commit came from', () => {
    delete process.env.COMMIT_ID;
    const info = buildInfo.publicInfo();
    expect(['env', 'checkout', 'build', 'unknown']).toContain(info.commitSource);
  });
});
