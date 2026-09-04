// A framed request that arrives with NO cookies cannot be fixed by signing in:
// the browser refuses the session cookie the same way it refused the first one,
// so /login just bounces back and forth. Explain instead of looping (#217).
//
// The instructor's deep-link picker already does this. Students hit the same
// wall through ordinary pages when an assignment is not set to open in a new
// tab, and they are the ones who cannot fix it themselves.
require('../../helpers/flow.cjs');

async function server() {
  const s = await require('../../../app.js');
  try { await s.initialize(); }
  catch (e) { if (!/Cannot initialize server while it is/i.test(String(e && e.message))) throw e; }
  return s;
}

const FRAMED   = { 'sec-fetch-dest': 'iframe' };
const UNFRAMED = { 'sec-fetch-dest': 'document' };

describe('a framed, cookie-less request is explained, not looped', () => {
  it('renders the cookie explanation instead of redirecting to /login', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/home', headers: FRAMED });

    expect(res.statusCode, 'should not bounce to /login').not.toBe(302);
    expect(res.headers.location || '').not.toMatch(/\/login/);
    expect(res.payload).toMatch(/third-party cookies|new tab/i);
  });

  it('leaves an ordinary top-level request redirecting to /login', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/home', headers: UNFRAMED });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  it('leaves a framed request that DID send cookies alone', async () => {
    // Cookies arriving at all means the browser is not blocking them, so a
    // login redirect is honest here — this is a signed-out user, not a trap.
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/home',
      headers: Object.assign({ cookie: 'somethingelse=1' }, FRAMED)
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });
});
