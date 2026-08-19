'use strict';

// CSP for /embed/* responses, selected by run mode.
//
// Test mode (runMode=calculator) should be self-contained — no outside images,
// media, frames or network — while normal embeds keep remote images so existing
// course material still renders. Frames are disallowed in both modes.

const { policyFor } = require('../../../lib/util/embedCsp');

const CONFIG = {
  enabled: true,
  cdnOrigins: ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'],
  fontOrigins: ['fonts.googleapis.com'],
  standard: "default-src 'none'; script-src 'self' {cdn}; style-src 'self' {cdn} {fonts}; font-src 'self' {cdn} {fonts}; img-src * data:; connect-src *; frame-src 'none'; child-src 'none'; worker-src 'self' blob:",
  exam: "default-src 'none'; script-src 'self' {cdn}; style-src 'self' {cdn} {fonts}; font-src 'self' {cdn} {fonts}; img-src 'self' data:; connect-src 'self' {cdn}; frame-src 'none'; child-src 'none'; worker-src 'self' blob:"
};

describe('embed CSP', function() {
  it('applies the standard policy to a normal embed', function() {
    const p = policyFor(CONFIG, '/embed/glowscript/abc123', '');
    expect(p).toContain("img-src * data:");
    expect(p).toContain("frame-src 'none'");
  });

  it('applies the exam policy when runMode=calculator', function() {
    const p = policyFor(CONFIG, '/embed/glowscript/abc123', 'calculator');
    expect(p).toContain("img-src 'self' data:");
    expect(p).not.toContain('img-src *');
  });

  // No program has a reason to embed a frame, so this holds in both modes —
  // a mis-set runMode should not change it.
  it("forbids frames in BOTH modes", function() {
    expect(policyFor(CONFIG, '/embed/glowscript/x', '')).toContain("frame-src 'none'");
    expect(policyFor(CONFIG, '/embed/glowscript/x', 'calculator')).toContain("frame-src 'none'");
  });

  // The runtimes still need their CDNs (MathJax; pyodide.js + wheels). Once
  // those are vendored locally, cdnOrigins goes empty and this tightens itself.
  it('substitutes the configured CDN origins', function() {
    const p = policyFor(CONFIG, '/embed/python3/x', 'calculator');
    expect(p).toContain('cdn.jsdelivr.net');
    expect(p).not.toContain('{cdn}');
  });

  it('collapses to no CDN allowance when the list is empty', function() {
    const p = policyFor(Object.assign({}, CONFIG, { cdnOrigins: [] }), '/embed/glowscript/x', '');
    expect(p).not.toContain('{cdn}');
    expect(p).toContain("script-src 'self';");
  });

  // pyodide embeds get the same policy — the hook keys on the path prefix and
  // runMode, not on the trinket type.
  it('covers pyodide embeds as well as glowscript', function() {
    expect(policyFor(CONFIG, '/embed/pyodide/x', 'calculator')).toContain("img-src 'self' data:");
  });


  // worker-src must be stated explicitly: it falls back to child-src, and
  // child-src is 'none' here, so omitting it would stop the worker runtimes
  // from starting at all. The worker inherits the policy, so allowing it does
  // not widen what the program can reach.
  it('permits blob: workers in both modes', function() {
    ['', 'calculator'].forEach(function(mode) {
      const p = policyFor(CONFIG, '/embed/python3/x', mode);
      expect(p).toContain("worker-src 'self' blob:");
    });
  });


  // The embed pulls several assets with protocol-relative URLs, so they are
  // http on a local stack and https in production. Host entries carry no
  // scheme so both match — pinning https would break local development and
  // any http deployment.
  it('keeps CDN hosts scheme-less', function() {
    const p = policyFor(CONFIG, '/embed/glowscript/x', '');
    expect(p).toContain('cdnjs.cloudflare.com');
    expect(p).not.toContain('https://cdnjs');
  });

  // The CDNs serve stylesheets as well as scripts, and the font services serve
  // a stylesheet plus the font files.
  it('allows CDN and font origins for styles and fonts', function() {
    const p = policyFor(CONFIG, '/embed/glowscript/x', 'calculator');
    const style = /style-src[^;]*/.exec(p)[0];
    const font = /font-src[^;]*/.exec(p)[0];
    expect(style).toContain('cdnjs.cloudflare.com');
    expect(style).toContain('fonts.googleapis.com');
    expect(font).toContain('fonts.googleapis.com');
  });

  it('does not touch non-embed pages', function() {
    expect(policyFor(CONFIG, '/', '')).toBeNull();
    expect(policyFor(CONFIG, '/mytrinkets', 'calculator')).toBeNull();
  });

  it('is a no-op when disabled or unconfigured', function() {
    expect(policyFor(Object.assign({}, CONFIG, { enabled: false }), '/embed/glowscript/x', '')).toBeNull();
    expect(policyFor(null, '/embed/glowscript/x', '')).toBeNull();
  });
});
