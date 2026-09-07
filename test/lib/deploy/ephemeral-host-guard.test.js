'use strict';

// The guard that keeps deploy-test identities off real deploys.
//
// TRIAL_HOSTS_EXTRA exists so other operators (Andrew's staging server, a
// self-hoster's scratch box) can use the harness without editing the file. That
// convenience must not become a way to point it at a student body, so the
// production hosts are refused even when explicitly named.
const path = require('path');
const guard = require(path.join(__dirname, '..', '..', 'browser', 'ephemeral-identity.js'));

describe('which hosts may have test identities minted on them', () => {
  const real = process.env.TRIAL_HOSTS_EXTRA;
  afterEach(() => {
    if (real === undefined) delete process.env.TRIAL_HOSTS_EXTRA;
    else process.env.TRIAL_HOSTS_EXTRA = real;
  });

  it('allows a known trial', () => {
    delete process.env.TRIAL_HOSTS_EXTRA;
    expect(guard.assertMintable('https://rba-merge-trial.spvi.net'))
      .toBe('rba-merge-trial.spvi.net');
  });

  it('refuses an unknown host — fail closed', () => {
    delete process.env.TRIAL_HOSTS_EXTRA;
    expect(() => guard.assertMintable('https://trinket-staging.drewsday.com'))
      .toThrow(/not a known trial host/);
  });

  it('lets an operator opt their own trial in via TRIAL_HOSTS_EXTRA', () => {
    process.env.TRIAL_HOSTS_EXTRA = 'trinket-staging.drewsday.com';
    expect(guard.assertMintable('https://trinket-staging.drewsday.com'))
      .toBe('trinket-staging.drewsday.com');
  });

  it('accepts a comma-separated list, and ignores whitespace', () => {
    process.env.TRIAL_HOSTS_EXTRA = ' a.example.com , b.example.com ';
    expect(guard.assertMintable('https://b.example.com')).toBe('b.example.com');
  });

  // The one that matters. An env var is easy to set by accident — a shell
  // profile, a CI variable, a copied command line.
  it('refuses PRODUCTION even when TRIAL_HOSTS_EXTRA names it', () => {
    for (const host of guard.NEVER_MINTABLE) {
      process.env.TRIAL_HOSTS_EXTRA = host;
      expect(() => guard.assertMintable('https://' + host),
        host + ' must never be mintable').toThrow(/PRODUCTION deploy/);
    }
  });

  it('names the real production deploys', () => {
    expect(guard.NEVER_MINTABLE.has('rba-uindy.spvi.net')).toBe(true);
    expect(guard.NEVER_MINTABLE.has('trinket.matterandinteractions.org')).toBe(true);
    expect(guard.NEVER_MINTABLE.has('trinket.gopicup.org')).toBe(true);
  });
});

// Ordering: the form-auth bow-out must come BEFORE the allowlist assertion.
//
// globalSetup called assertMintable() first, then probed /login and returned
// early on a password field. assertMintable THROWS, and a throw in globalSetup
// kills the whole run — so on a form-auth deploy whose host is not on the
// allowlist, the anonymous specs died too, and the bow-out immediately below
// could never be reached. The bow-out was only ever observed working from
// trial-merge.spvi.net, which is already permitted.
//
// Reordering does not weaken the guard: a form-auth deploy has no Firebase to
// mint against, so the allowlist would be gating a path that cannot be taken,
// and nothing is created before the check either way. Reported by @drewsday
// against the PICUP VPS staging box (#237, after merge).
const fs2   = require('fs');
const path2 = require('path');

describe('ephemeral-setup ordering', () => {
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', '..', 'browser', 'ephemeral-setup.js'), 'utf8');

  it('bows out of form-auth deploys before asserting the host is mintable', () => {
    const probe  = src.search(/type="password"/);
    const assert = src.search(/assertMintable\s*\(/);
    expect(probe,  'the /login form-auth probe should exist').toBeGreaterThan(-1);
    expect(assert, 'assertMintable should still be called').toBeGreaterThan(-1);
    expect(probe,
      'assertMintable throws, and a throw in globalSetup kills the whole run — '
      + 'so it must not run before the form-auth bow-out, or a form-auth deploy '
      + 'off the allowlist takes the anonymous specs down with it')
      .toBeLessThan(assert);
  });

  it('still asserts before anything is minted', () => {
    const assert = src.search(/assertMintable\s*\(/);
    const mint   = src.search(/ephemeral\.mint\s*\(/);
    expect(mint, 'minting should still happen').toBeGreaterThan(-1);
    expect(assert, 'refuse before creating anything, not after').toBeLessThan(mint);
  });

  it('refuses production LOUDLY, before the form-auth probe', () => {
    // Two of the three NEVER_MINTABLE hosts serve a password form
    // (trinket.gopicup.org confirmed), so a form-auth probe placed first would
    // answer "nothing to mint" for a production deploy instead of naming it.
    // Nothing is minted either way; what is lost is the operator being told
    // what they just pointed the suite at.
    const prod  = src.search(/assertNotProduction\s*\(/);
    const probe = src.search(/type="password"/);
    expect(prod, 'globalSetup should refuse production first').toBeGreaterThan(-1);
    expect(prod).toBeLessThan(probe);
  });

  it('still refuses a production host by name', () => {
    const e = require('../../browser/ephemeral-identity.js');
    expect(() => e.assertNotProduction('https://trinket.gopicup.org'))
      .toThrow(/PRODUCTION/);
    expect(() => e.assertNotProduction('https://rba-merge-trial.spvi.net'))
      .not.toThrow();
  });
});
