'use strict';

// The FirebaseUI login template must build signInOptions from the injected
// authProviders list (config-driven), not a hardcoded two-provider array, so a
// Google-only deploy shows only Google. Static markup assertions — there is no
// DOM/FirebaseUI harness here (same style as course-editor-menu.test.js).

const fs   = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '../../lib/views/login-firebase.html');
const html = fs.readFileSync(TEMPLATE, 'utf8');

describe('login-firebase.html — config-driven signInOptions', () => {
  it('injects the server-provided authProviders list', () => {
    expect(html).toMatch(/var\s+authProviders\s*=\s*\{%\s*if\s+authProviders\s*%\}/);
  });

  it('maps both supported provider names to FirebaseUI PROVIDER_IDs', () => {
    expect(html).toMatch(/google:\s*firebase\.auth\.GoogleAuthProvider\.PROVIDER_ID/);
    expect(html).toMatch(/password:\s*firebase\.auth\.EmailAuthProvider\.PROVIDER_ID/);
  });

  it('builds signInOptions from the list with a google fallback', () => {
    expect(html).toMatch(/signInOptions\s*=\s*.*authProviders/s);
    expect(html).toMatch(/if\s*\(\s*!signInOptions\.length\s*\)/);
  });

  it('no longer hardcodes an unconditional two-provider signInOptions array', () => {
    expect(html).not.toMatch(/signInOptions:\s*\[\s*firebase\.auth\.EmailAuthProvider\.PROVIDER_ID/);
  });
});
