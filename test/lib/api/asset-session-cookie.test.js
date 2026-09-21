// A versioned asset response must not carry Set-Cookie.
//
// Cloudflare (and any shared cache) refuses to store a response bearing
// Set-Cookie. The sliding-expiration touch in app.js marked the session dirty
// on EVERY authenticated request, so yar re-issued the cookie on fingerprinted
// assets too -- and the edge then bypassed the cache for exactly the users who
// matter. Measured on mandi 2026-09-21: one 1.06 MB GlowScript runtime pulled
// from the origin 95 times in 40 minutes through a single Cloudflare edge,
// every request `cf-cache-status: BYPASS`, while the same URL fetched
// anonymously returned HIT.
//
// The fix must not cost anyone their session, so the second test here is the
// one that matters: after an asset request, the user is still logged in.

const flow   = require('../../helpers/flow.cjs');
const config = require('config');

const ASSET = '/cache-prefix-abc1234/css/base.css';

let prevCache;
beforeEach(() => {
  flow.cookies = {};
  prevCache = config.app.cache;
  config.app.cache = { enabled: true, staticMaxAge: 31536000 };
});
afterEach(() => { config.app.cache = prevCache; });

describe('versioned assets and the session cookie', () => {
  it('an AUTHENTICATED request for a versioned asset sets no cookie', async () => {
    await flow.switchUser('user');          // establishes a logged-in session
    await flow.get(ASSET);
    const setCookie = flow.lastResponse.headers['set-cookie'];
    expect(setCookie, 'a fingerprinted asset must never re-issue the session cookie')
      .toBeUndefined();
  });

  it('the session SURVIVES an asset request', async () => {
    await flow.switchUser('user');
    await flow.get(ASSET);                  // must not log the user out
    await flow.get('/api/courses');
    expect(flow.lastResponse.statusCode).toBe(200);
  });

  it('a normal page request still refreshes the session', async () => {
    await flow.switchUser('user');
    await flow.get('/api/courses');
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.headers['set-cookie'],
      'a normal request still touches the session, so the cookie is re-issued')
      .toBeDefined();
  });
});
