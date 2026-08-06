'use strict';

// auth.loginPage feeds the FirebaseUI login template. It must thread the
// configured provider list (auth.firebase.providers) into the view context as
// `authProviders`, so per-deploy overlays can control which sign-in buttons
// show — and never emit an empty list (unusable login box).

const config = require('config');
const auth   = require('../../lib/controllers/auth');

// Call loginPage with a request stub that captures the view context object
// passed to request.success(...). reply is unused by loginPage.
function invoke() {
  let captured;
  auth.loginPage({ success: (ctx) => { captured = ctx; return ctx; } });
  return captured;
}

describe('auth.loginPage — authProviders', () => {
  it('defaults to the stock two-provider list from config', () => {
    expect(invoke().authProviders).toEqual(['google', 'password']);
  });

  it('threads a per-deploy override through unchanged', () => {
    const orig = config.auth.firebase.providers;
    config.auth.firebase.providers = ['google'];
    try {
      expect(invoke().authProviders).toEqual(['google']);
    } finally {
      config.auth.firebase.providers = orig;
    }
  });

  it('falls back to google-only when firebase config is absent', () => {
    const orig = config.auth.firebase;
    config.auth.firebase = undefined;
    try {
      expect(invoke().authProviders).toEqual(['google']);
    } finally {
      config.auth.firebase = orig;
    }
  });

  it('falls back to google-only when providers is a non-array (scalar) misconfig', () => {
    const orig = config.auth.firebase.providers;
    config.auth.firebase.providers = 'google';   // scalar, not a list
    try {
      expect(invoke().authProviders).toEqual(['google']);
    } finally {
      config.auth.firebase.providers = orig;
    }
  });
});
