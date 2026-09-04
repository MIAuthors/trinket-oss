'use strict';

// The glowscript runner must request its assets under the versioned prefix.
//
// lib/util/stringUtils.addPrefix defines the contract every other asset URL
// follows: use config.app.prefixes.<kind> when set, otherwise fall back to
// `/cache-prefix-<token>`. glowscript-config.html implemented only the first
// half — it honoured an explicit prefix and emitted NOTHING otherwise. Since
// prefixes.components is empty in default.yaml and in every deploy overlay,
// the runner loaded bare paths.
//
// That matters because of what the two paths are served with. Measured on a
// live trial (no CDN):
//   /components/.../glow.3.2.3.min.js              -> no-store   (every load!)
//   /cache-prefix-<commit>/components/.../glow...  -> immutable, 1 year
// and behind Firebase Hosting the bare path is max-age=300, so students
// re-downloaded 4.2 MB every five minutes — during a real physics exam on
// 2026-09-01, ~1000 students, 14.26 GiB of egress for ~7 GiB of content.
const flow = require('../../helpers/flow.cjs');

const RUNNER_PAGES = ['/embed/glowscript', '/embed/glowscript-blocks'];

describe('the glowscript runner uses versioned asset URLs', () => {
  beforeEach(() => { flow.cookies = {}; });

  RUNNER_PAGES.forEach((page) => {
    it(`${page} emits a cache-prefix, not a bare path`, async () => {
      const res = await flow.get(page);
      if (res.statusCode === 404) return;          // page not served by this deploy
      expect(res.statusCode).toBe(200);

      const m = /var prefix = '([^']*)'/.exec(res.text);
      expect(m, `could not find the runner prefix declaration in ${page}`).not.toBeNull();
      expect(m[1], 'an empty prefix makes the runner load uncacheable bare paths')
        .not.toBe('');
      expect(m[1]).toMatch(/^cache-prefix-[^/]+\/$/);
    });
  });

  it('keeps honouring an explicitly configured components prefix', async () => {
    const config = require('config');
    const real = config.app.prefixes.components;
    config.app.prefixes.components = 'cdn.example.com/assets';
    try {
      const res = await flow.get(RUNNER_PAGES[0]);
      const m = /var prefix = '([^']*)'/.exec(res.text);
      expect(m[1], 'an explicit prefix must still win over the cache-prefix fallback')
        .toBe('cdn.example.com/assets/');
    } finally {
      config.app.prefixes.components = real;
    }
  });
});
