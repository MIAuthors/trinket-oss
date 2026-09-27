// A cross-site LMS frame with third-party cookies blocked cannot keep the
// session cookie, so student launches and SpeedGrader review landed on the
// cookie-guidance page after a successful launch (#286). A `Partitioned` copy
// of the session cookie, same name, is stored where the plain one is refused;
// when a browser sends both, the first is honoured.
//
// The copy is only emitted when the session cookie is Secure. With a
// config/local.yaml that sets isSecure:false / protocol http (a dev overlay)
// the first two cases fail; the container loop masks local.yaml.
'use strict';
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

async function server() {
  const s = await require('../../../app.js');
  try { await s.initialize(); }
  catch (e) { if (!/Cannot initialize server while it is/i.test(String(e && e.message))) throw e; }
  return s;
}

const FB_MODE = process.env.TEST_AUTH_PROVIDER === 'firebase';
const FRAMED_CROSS_SITE = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' };
const FRAMED_SAME_ORIGIN = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' };
const FETCH_IN_FRAME    = { 'sec-fetch-dest': 'empty',  'sec-fetch-site': 'same-origin' };
const TOP_LEVEL         = { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };

beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

function signup() {
  const data = defaults.extend(defaults.extend({}, 'user'), 'recaptcha');
  data.formName = 'signup';
  return data;
}

function sessionEntries(res) {
  return [].concat(res.headers['set-cookie'] || []).filter((c) => /^session=/.test(c));
}

describe.skipIf(FB_MODE)('the session cookie gets a partitioned twin in cross-site frames', () => {
  it('a cross-site framed sign-in sets the cookie twice: plain, then the same value Partitioned', async () => {
    const s = await server();
    const res = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const c = sessionEntries(res);
    expect(c, 'two session cookies').toHaveLength(2);
    expect(c[0]).not.toMatch(/Partitioned/);
    expect(c[1]).toMatch(/; Partitioned$/);
    expect(c[1]).toMatch(/SameSite=None/);
    expect(c[1]).toMatch(/Secure/);
    // Same encrypted payload — one session, two jars.
    expect(c[1].split(';')[0]).toBe(c[0].split(';')[0]);
  });

  it('a top-level sign-in sets BOTH, so it refreshes the twin too (#314)', async () => {
    // This asserted "exactly one, unpartitioned" until #314. Trinket embeds
    // itself in a same-origin iframe, so a first-party twin already exists by
    // the time anyone signs in; refreshing only the plain cookie left the twin
    // holding its pre-login value, and dedupe picks by position, so the stale
    // one won every subsequent request. Writing both together is what makes
    // divergence impossible.
    const s = await server();
    const res = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: TOP_LEVEL });
    const c = sessionEntries(res);
    expect(c).toHaveLength(2);
    expect(c[0]).not.toMatch(/Partitioned/);
    expect(c[1]).toMatch(/; Partitioned$/);
    expect(c[1].split(';')[0], 'same value in both jars').toBe(c[0].split(';')[0]);
  });

  it('the partitioned copy is a valid session on its own (same value, so the plain jar is not needed)', async () => {
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const partitioned = sessionEntries(login)[1].split(';')[0];
    const res = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: partitioned }, FRAMED_CROSS_SITE) });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toMatch(/needs to open in a new tab/);
  });

  it('a browser that sends BOTH jars is signed in — hapi would otherwise see an array', async () => {
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const plain = sessionEntries(login)[0].split(';')[0];
    const res = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: plain + '; ' + plain }, FRAMED_CROSS_SITE) });
    expect(res.statusCode).toBe(200);
  });

  it('when the two differ, the first wins (the browser lists the plain, older cookie first)', async () => {
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const plain = sessionEntries(login)[0].split(';')[0];
    const ok  = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: plain + '; session=stale' }, FRAMED_CROSS_SITE) });
    expect(ok.statusCode).toBe(200);
    const bad = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: 'session=stale; ' + plain }, TOP_LEVEL) });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toMatch(/\/login/);
  });

  it('a fetch from inside the frame re-sets BOTH, so neither jar is left behind (#314)', async () => {
    // Also inverted by #314, and for the same reason: a fetch that rotates the
    // session must not update one jar and not the other. Whatever writes the
    // cookie writes both copies of it.
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const plain = sessionEntries(login)[0].split(';')[0];
    // /api/users/me-style calls touch the session; any authenticated JSON route will do.
    const res = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: plain }, FETCH_IN_FRAME) });
    expect(res.statusCode).toBe(200);
    const c = sessionEntries(res);
    expect(c.length, 'session cookie re-set on the fetch').toBeGreaterThan(0);
    const partitioned = c.filter((v) => /Partitioned/.test(v));
    expect(partitioned, 'the twin is refreshed alongside the plain cookie').toHaveLength(1);
    expect(partitioned[0].split(';')[0]).toBe(c[0].split(';')[0]);
  });

  it('the same-origin embed that creates the first-party twin (#314 trigger)', async () => {
    // The step that made this reachable at all, recorded so the trigger is not
    // lost: a trinket page loads /embed/<lang>/<id> in a SAME-ORIGIN iframe.
    // wantsCopy's original comment reasoned that "no partitioned cookie is
    // created in a first-party jar to go stale against the plain one" — true
    // only if nothing same-origin is ever framed, which trinket does to itself.
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: TOP_LEVEL });
    const plain = sessionEntries(login)[0].split(';')[0];
    const res = await s.inject({
      method: 'GET', url: '/home',
      headers: Object.assign({ cookie: plain }, FRAMED_SAME_ORIGIN)
    });
    const c = sessionEntries(res);
    expect(c.some((v) => /Partitioned/.test(v)),
      'a same-origin frame writes a twin into the FIRST-PARTY jar').toBe(true);
  });

  it('a page the framed app navigates to (same-origin, still in the frame) keeps both jars in step', async () => {
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const plain = sessionEntries(login)[0].split(';')[0];
    const res = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: plain }, FRAMED_SAME_ORIGIN) });
    expect(res.statusCode).toBe(200);
    const c = sessionEntries(res);
    expect(c).toHaveLength(2);
    expect(c[1]).toMatch(/; Partitioned$/);
  });

  it('logout inside the frame re-seals both jars alike, with the cookie:true Expires on both', async () => {
    // /logout is a `cookie: true` route (yar.reset re-seals an empty session
    // rather than clearing the cookie); the year-long Expires must ride on the
    // copy too, or the two jars would age differently.
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const plain = sessionEntries(login)[0].split(';')[0];
    const res = await s.inject({ method: 'GET', url: '/logout', headers: Object.assign({ cookie: plain }, FRAMED_SAME_ORIGIN) });
    expect(res.statusCode).toBe(302);
    const c = sessionEntries(res);
    expect(c).toHaveLength(2);
    expect(c[0].split(';')[0]).not.toBe(plain);            // a new, signed-out session
    expect(c[0]).toMatch(/; Expires=/);
    expect(c[1]).toMatch(/; Expires=.*; Partitioned$/);
    expect(c[1].split(';')[0]).toBe(c[0].split(';')[0]);
    // and it really is signed out
    const after = await s.inject({ method: 'GET', url: '/home', headers: Object.assign({ cookie: c[1].split(';')[0] }, FRAMED_SAME_ORIGIN) });
    expect(after.statusCode).toBe(302);
  });

  it('a Boom-rendered page inside the frame still carries the copy (the raw response is patched, not the hapi one)', async () => {
    const s = await server();
    const login = await s.inject({ method: 'POST', url: '/users', payload: signup(), headers: FRAMED_CROSS_SITE });
    const plain = sessionEntries(login)[0].split(';')[0];
    // /admin/users is forbidden to a plain user: Boom 403 → the error hook renders 403.html.
    const res = await s.inject({ method: 'GET', url: '/admin/users', headers: Object.assign({ cookie: plain }, FRAMED_SAME_ORIGIN) });
    expect(res.statusCode).toBe(403);
    const c = sessionEntries(res);
    expect(c.length, 'session cookie re-set on the error page').toBeGreaterThan(0);
    expect(c.some((v) => /; Partitioned$/.test(v))).toBe(true);
  });
});

describe('without any cookie the framed guidance still applies', () => {
  it('renders the cookie explanation for a framed, cookie-less request', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/home', headers: FRAMED_CROSS_SITE });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatch(/new tab/i);
  });
});
