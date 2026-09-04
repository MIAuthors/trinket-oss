// The instructor half of #217. A deep-linking launch lands in the LMS's iframe;
// if the browser blocks third-party cookies the session the launch just created
// never comes back to us. /lti/deep-link therefore runs with auth mode 'try' so
// the handler can explain, rather than 401 → /login → a sign-in whose cookie the
// browser refuses just the same.
//
// The student half lives in framed-login-loop.test.js: same cause, different
// entry point, and students get different advice because they cannot fix it.
require('../../helpers/flow.cjs');

async function server() {
  const s = await require('../../../app.js');
  try { await s.initialize(); }
  catch (e) { if (!/Cannot initialize server while it is/i.test(String(e && e.message))) throw e; }
  return s;
}

describe('deep-link picker without a session', () => {
  it('explains the cookie block when the request is framed', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/lti/deep-link',
      headers: { 'sec-fetch-dest': 'iframe' }
    });

    expect(res.statusCode, 'must not bounce to /login').not.toBe(302);
    expect(res.headers.location || '').not.toMatch(/\/login/);
    expect(res.payload).toMatch(/cookie/i);
  });

  it('does not show the cookie page for an ordinary top-level request', async () => {
    // Unframed and session-less is not the cookie trap — it is someone who
    // opened the URL directly. Whatever we do there, it must not be the page
    // that tells them to allow third-party cookies.
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/lti/deep-link',
      headers: { 'sec-fetch-dest': 'document' }
    });

    expect(res.payload || '').not.toMatch(/third-party cookies/i);
  });
});
