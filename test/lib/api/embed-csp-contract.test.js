'use strict';

// The contract between the embed CSP and the code that runs under it.
//
// #224 shipped because both halves were individually healthy AND individually
// tested: embedCsp.test.js pins `frame-src 'none'` ("forbids frames in BOTH
// modes"), the download route has its own tests, and the client handler threw no
// exceptions. Nothing asserted the RELATIONSHIP — that no shipped feature
// depends on a capability the policy forbids. Download used a form POST into a
// hidden iframe, so it was dead on arrival on every deploy carrying the policy,
// silently, for four days across two production sites.
//
// These are the assertions that would have failed the moment the policy landed.
const fs   = require('fs');
const path = require('path');

const EMBED_JS = path.join(__dirname, '..', '..', '..', 'public', 'js', 'embed');

function embedSources() {
  return fs.readdirSync(EMBED_JS)
    .filter(function (f) { return /\.js$/.test(f); })
    .map(function (f) { return { file: f, body: fs.readFileSync(path.join(EMBED_JS, f), 'utf8') }; });
}

describe('embed CSP contract', function () {
  it('serves a policy that forbids form submission and framing', async function () {
    const s = await require('../../../app.js');
    try { await s.initialize(); }
    catch (e) { if (!/Cannot initialize server while it is/i.test(String(e && e.message))) throw e; }

    const res = await s.inject({ method: 'GET', url: '/embed/python3' });
    const csp = res.headers['content-security-policy'] || '';

    expect(csp, 'embed pages must carry a CSP').toBeTruthy();
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  // The point of the pair: the directives above are deliberate, so any embed
  // code that submits a form or targets an iframe is dead by construction. If a
  // feature needs one of these, the choice is to change the policy ON PURPOSE
  // (and update the assertion above) or to implement it another way — not to
  // ship a control that silently does nothing.
  it('has no embed code that depends on submitting a form', function () {
    const offenders = embedSources()
      .filter(function (s) { return /createElement\(\s*['"]form['"]\s*\)|\.submit\(\s*\)/.test(s.body); })
      .map(function (s) { return s.file; });

    expect(offenders,
      'these submit forms, which "form-action \'none\'" blocks — they will fail silently: '
      + offenders.join(', ')).toEqual([]);
  });

  it('has no embed code that loads a frame to do its work', function () {
    // Excludes the trinket's own output frames, which are created by the runner
    // templates rather than here; this covers the embed's OWN chrome.
    const offenders = embedSources()
      .filter(function (s) { return /createElement\(\s*['"]iframe['"]\s*\)/.test(s.body); })
      .map(function (s) { return s.file; });

    expect(offenders,
      'these create iframes, which "frame-src \'none\'" blocks: ' + offenders.join(', ')).toEqual([]);
  });
});
