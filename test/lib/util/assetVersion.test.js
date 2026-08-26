// Caching an asset is only safe if its URL rolls when the asset does. The
// existing fallback stamps `Date.now()` at RENDER time, so two requests 229 ms
// apart on a live deploy produced two different URLs for the same file —
// meaning even a correct Cache-Control header would never yield a hit.
const assetVersion = require('../../../lib/util/assetVersion');

describe('assetVersion.tokenFrom', () => {
  it('prefers an explicit build commit, shortened', () => {
    expect(assetVersion.tokenFrom({ commit: 'a1b2c3d', commitSource: 'env' }, 1000))
      .toBe('a1b2c3d');
  });

  it('is stable across calls — the whole point', () => {
    const info = { commit: 'a1b2c3d', commitSource: 'env' };
    expect(assetVersion.tokenFrom(info, 1000)).toBe(assetVersion.tokenFrom(info, 9999));
  });

  it('rolls when the deploy rolls', () => {
    expect(assetVersion.tokenFrom({ commit: 'a1b2c3d', commitSource: 'env' }, 1000))
      .not.toBe(assetVersion.tokenFrom({ commit: 'e4f5a6b', commitSource: 'env' }, 1000));
  });

  it('falls back to a boot timestamp when the build identity is unknown', () => {
    // Dev runs (`node app.js`, no build args, no .git) must still work — and a
    // per-BOOT value is still vastly better than a per-RENDER one.
    expect(assetVersion.tokenFrom({ commit: 'unknown', commitSource: 'unknown' }, 1234))
      .toBe('1234');
  });

  it('treats a missing commit like an unknown one', () => {
    expect(assetVersion.tokenFrom({}, 1234)).toBe('1234');
  });

  it('produces a token safe to place in a URL path segment', () => {
    expect(assetVersion.tokenFrom({ commit: 'a1b2c3d', commitSource: 'env' }, 1000))
      .toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('assetVersion.token caching', () => {
  it('does not re-read build identity on every call', () => {
    // addPrefix runs once per asset per render — dozens of times per page.
    // Resolving the commit reads files, so it must be memoised.
    let calls = 0;
    const resolve = () => { calls++; return { commit: 'a1b2c3d', commitSource: 'env' }; };
    const v = assetVersion.create(resolve, () => 5000);
    v.token(); v.token(); v.token();
    expect(calls).toBe(1);
  });

  it('re-checks after the TTL, so a bind-mounted `git pull` rolls without a restart', () => {
    let commit = 'a1b2c3d', calls = 0, now = 5000;
    const v = assetVersion.create(
      () => { calls++; return { commit: commit, commitSource: 'checkout' }; },
      () => now
    );
    expect(v.token()).toBe('a1b2c3d');
    commit = 'e4f5a6b';
    now += 1000;                       // within the TTL — still the old token
    expect(v.token()).toBe('a1b2c3d');
    now += 60000;                      // past it
    expect(v.token()).toBe('e4f5a6b');
    expect(calls).toBe(2);
  });

  it('never re-checks a build-arg stamped image — it cannot change', () => {
    // COMMIT_ID comes from the image build, so unlike a bind-mounted checkout
    // there is nothing to re-read. Expiring that would be pure wasted I/O.
    let calls = 0, now = 5000;
    const v = assetVersion.create(
      () => { calls++; return { commit: 'a1b2c3d', commitSource: 'env' }; },
      () => now
    );
    expect(v.token()).toBe('a1b2c3d');
    now += 3600000;
    expect(v.token()).toBe('a1b2c3d');
    expect(calls).toBe(1);
  });
});
