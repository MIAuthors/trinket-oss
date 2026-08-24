'use strict';

// The lockdown-browser recovery path: under the measured cold-start herd,
// Cloud Run shed glow.min.js for 172/1000 students, and Safe Exam Browser /
// Respondus give a student no refresh. The policy decides when the page
// rebuilds the runner; these tests pin its budget, backoff, burst-collapse,
// and what counts as a runtime file.

const { create, isRuntimeFile } = require('../../public/js/embed/runner-retry');

describe('isRuntimeFile', () => {
  it('claims the runtime the scene cannot work without', () => {
    [
      'https://x/components/vpython-glowscript/package/glow.3.2.3.min.js',
      'https://x/components/vpython-glowscript/package/RSrun.3.2.3.min.js',
      'https://x/components/vpython-glowscript/package/RScompiler.3.2.3.min.js',
      'https://x/components/vpython-glowscript/lib/jquery/2.1/jquery.min.js',
    ].forEach((src) => expect(isRuntimeFile(src), src).toBe(true));
  });

  it('leaves cosmetics and third parties alone — a rebuild would interrupt a working scene', () => {
    [
      'https://x/components/vpython-glowscript/css/ide.css',
      'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.3/MathJax.js',
      '', undefined,
    ].forEach((src) => expect(isRuntimeFile(src), String(src)).toBe(false));
  });
});

describe('retry policy', () => {
  const GLOW = 'https://x/components/vpython-glowscript/package/glow.3.2.3.min.js';

  it('retries with increasing backoff, then exhausts', () => {
    const p = create({ delaysMs: [10, 20, 30] });
    expect(p.onLoadFailure(GLOW)).toEqual({ retry: true, delayMs: 10 });
    p.rebuilding();
    expect(p.onLoadFailure(GLOW)).toEqual({ retry: true, delayMs: 20 });
    p.rebuilding();
    expect(p.onLoadFailure(GLOW)).toEqual({ retry: true, delayMs: 30 });
    p.rebuilding();
    expect(p.onLoadFailure(GLOW)).toEqual({ retry: false, reason: 'exhausted' });
  });

  it('collapses a burst — sibling script tags failing together cost ONE rebuild', () => {
    const p = create({ delaysMs: [10, 20] });
    expect(p.onLoadFailure(GLOW).retry).toBe(true);
    // RSrun + RScompiler + jquery report while the rebuild is pending
    expect(p.onLoadFailure(GLOW.replace('glow', 'RSrun'))).toEqual({ retry: false, reason: 'pending' });
    expect(p.onLoadFailure(GLOW.replace('glow', 'RScompiler'))).toEqual({ retry: false, reason: 'pending' });
    p.rebuilding();
    // ...and after the rebuild, failures count again (attempt 2 of 2)
    expect(p.onLoadFailure(GLOW)).toEqual({ retry: true, delayMs: 20 });
  });

  it('a fresh Run resets the budget', () => {
    const p = create({ delaysMs: [10] });
    p.onLoadFailure(GLOW);
    p.rebuilding();
    expect(p.onLoadFailure(GLOW).reason).toBe('exhausted');
    p.reset();
    expect(p.onLoadFailure(GLOW)).toEqual({ retry: true, delayMs: 10 });
  });

  it('never spends the budget on files that are not the runtime', () => {
    const p = create({ delaysMs: [10] });
    expect(p.onLoadFailure('https://x/components/css/ide.css').reason).toBe('not-runtime');
    expect(p.onLoadFailure(GLOW).retry).toBe(true);   // budget still intact
  });
});
