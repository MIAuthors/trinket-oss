// The blanket `no-store` in app.js has applied to EVERY response since the
// initial open-source commit, including static assets. On a Cloud Run deploy
// that means every page view re-fetches ~267 KB of base.css from a billable
// container. These tests pin the rule that decides which responses may be
// cached.
const cacheControl = require('../../../lib/util/cacheControl');

const APP = { cachePrefix: 'cache-prefix-', cache: { enabled: true, staticMaxAge: 31536000 } };

const ccOf = (path, status = 200, app = APP) =>
  cacheControl.headersFor(path, status, app)['Cache-Control'];

describe('cacheControl.headersFor', () => {
  describe('versioned static assets', () => {
    it('makes a prefixed asset cacheable for a year, immutably', () => {
      expect(ccOf('/cache-prefix-a1b2c3d/css/base.css'))
        .toBe('public, max-age=31536000, immutable');
    });

    it('honours a deploy-configured max-age', () => {
      const app = { cachePrefix: 'cache-prefix-', cache: { enabled: true, staticMaxAge: 600 } };
      expect(ccOf('/cache-prefix-a1b2c3d/js/app.js', 200, app))
        .toBe('public, max-age=600, immutable');
    });

    it('drops Pragma and Expires, which would contradict the cache directive', () => {
      const h = cacheControl.headersFor('/cache-prefix-a1b2c3d/img/logo.png', 200, APP);
      expect(h.Pragma).toBeUndefined();
      expect(h.Expires).toBeUndefined();
    });

    it('caches a 304 too — a revalidation must not reset the asset to no-store', () => {
      expect(ccOf('/cache-prefix-a1b2c3d/css/base.css', 304))
        .toBe('public, max-age=31536000, immutable');
    });
  });

  describe('what must NOT be cached', () => {
    it('leaves ordinary pages on no-store', () => {
      expect(ccOf('/')).toContain('no-store');
      expect(ccOf('/mycourses')).toContain('no-store');
    });

    it('leaves API responses on no-store', () => {
      expect(ccOf('/api/trinkets/abc123')).toContain('no-store');
    });

    it('keeps Pragma and Expires on dynamic responses', () => {
      const h = cacheControl.headersFor('/', 200, APP);
      expect(h.Pragma).toBe('no-cache');
      expect(h.Expires).toBe('0');
    });

    it('never caches an UNVERSIONED asset — that URL cannot roll on deploy', () => {
      expect(ccOf('/css/base.css')).toContain('no-store');
      expect(ccOf('/js/app.js')).toContain('no-store');
    });

    it('never caches an error under a prefixed path, or a 404 sticks for a year', () => {
      expect(ccOf('/cache-prefix-a1b2c3d/css/missing.css', 404)).toContain('no-store');
      expect(ccOf('/cache-prefix-a1b2c3d/css/base.css', 500)).toContain('no-store');
      expect(ccOf('/cache-prefix-a1b2c3d/css/base.css', 302)).toContain('no-store');
    });

    it('does not treat a path that merely CONTAINS the prefix as versioned', () => {
      expect(ccOf('/trinkets/cache-prefix-a1b2c3d/css/base.css')).toContain('no-store');
    });
  });

  describe('the deploy-level off switch', () => {
    it('falls back to no-store everywhere when caching is disabled', () => {
      const off = { cachePrefix: 'cache-prefix-', cache: { enabled: false, staticMaxAge: 31536000 } };
      expect(ccOf('/cache-prefix-a1b2c3d/css/base.css', 200, off)).toContain('no-store');
    });

    it('stays off when the config block is absent entirely', () => {
      expect(ccOf('/cache-prefix-a1b2c3d/css/base.css', 200, { cachePrefix: 'cache-prefix-' }))
        .toContain('no-store');
    });

    it('preserves the exact legacy header string for dynamic responses', () => {
      expect(ccOf('/'))
        .toBe('private, s-maxage=0, max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate');
    });
  });
});


describe('staticMaxAge validation', () => {
  const APP = { cachePrefix: 'cache-prefix-', cache: { enabled: true, staticMaxAge: 60 } };

  it('honours a sane configured value', () => {
    const h = cacheControl.headersFor('/cache-prefix-abc/js/x.js', 200, APP);
    expect(h['Cache-Control']).toContain('max-age=60');
  });

  it('falls back to the default for NaN or negative values', () => {
    [NaN, -5].forEach((bad) => {
      const h = cacheControl.headersFor('/cache-prefix-abc/js/x.js', 200,
        { cachePrefix: 'cache-prefix-', cache: { enabled: true, staticMaxAge: bad } });
      expect(h['Cache-Control']).toContain('max-age=31536000');
      expect(h['Cache-Control']).not.toContain('NaN');
    });
  });
});
