'use strict';

const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

// Local-auth provider only (the signup form route isn't registered under
// auth.provider=firebase).
const FB_MODE = process.env.TEST_AUTH_PROVIDER === 'firebase';

// Regression for #89.
//
// The real signup form (lib/views/signup.html) submits a hidden
// formName="sign-up" (hyphenated), but the signup page route is GET /signup
// (no hyphen). POST /users' failure redirect was '/{formName}', which
// interpolated to /sign-up — a route that does not exist — so ANY soft signup
// failure (a duplicate account, most importantly) 302'd to /sign-up and then
// 404'd, instead of re-rendering the form with the flashed error.
//
// registration.test.js's duplicate/invalid tests never caught this because the
// flow harness's register() helper defaults formName to "signup" (the correct
// value). This test uses the form's ACTUAL value, "sign-up".
describe.skipIf(FB_MODE)('Duplicate signup with the form\'s real formName ("sign-up") (#89)', () => {
  it('redirects to /signup (not a 404) when the email already exists', async () => {
    // 1) Create the account (harness default formName="signup").
    await flow.register();
    expect(flow.lastResponse.statusCode).toBe(302); // → /welcome (sanity)

    // 2) A fresh visitor signs up again with the SAME email, submitting the
    //    hyphenated formName the actual signup.html form sends.
    flow.cookies = {};
    await flow.switchUser('');
    await flow.register({ formName: 'sign-up' });

    // The bug: the failure redirect landed on the nonexistent /sign-up → 404.
    // The fix: it re-renders the signup page.
    expect(flow.wasOk).toBe(true);
    expect(flow.lastResponse.statusCode).not.toBe(404);
    expect(flow.lastResponse.statusCode).toBe(302);
    expect(flow.lastRedirect.pathname).toBe('/signup');
  });
});
