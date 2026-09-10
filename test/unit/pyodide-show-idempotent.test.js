'use strict';

// Auto-display tracked the DOM, not which figures had been shown — picup #254.
//
// Three student-visible defects fell out of that one root cause, and all three
// are fixed by making plt.show() idempotent PER FIGURE. Measured in the embed
// before and after, on Pyodide 0.28.1 / matplotlib 3.8.4:
//
//   program                          | before          | after
//   ---------------------------------|-----------------|------------------
//   figure(); show(); figure()       | 1 of 2 drawn    | 2 of 2 drawn
//   6x { cla(); plot(); show() }      | 6 containers,   | 1 container,
//                                    | 3726px, 25.2s   | 621px, 3.1s
//   close(); figure(); show()        | worker: skipped | drawn
//
// The mechanism, which is what these assertions protect:
//
// Pyodide's webagg manager.show() builds a BRAND NEW mpl.figure and appends it
// to document.pyodideMplTarget on every call, overwriting self.js_fig. So
// `js_fig` is the "already on the page" marker. It lives on the MANAGER, and
// that is load-bearing: plt.close() destroys the manager, so a figure created
// afterwards gets a fresh one with no js_fig even though matplotlib REUSES the
// figure number. Measured: two successive figures both reporting number 1 with
// different id(). A registry keyed on the NUMBER — which is what the worker
// does at pyodide-worker.js `_trinket_show` — silently never draws the second.
const fs   = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('plt.show() is idempotent per figure (#254)', () => {
  const src = () => read('public/js/embed/pyodide.js');

  it('patches pyplot.show in the matplotlib setup', () => {
    expect(src(), 'the student calls plt.show(); the patch has to be on the module')
      .toMatch(/_plt\.show\s*=\s*_trinket_show/);
  });

  it('keys "already shown" on the manager, never on the figure number', () => {
    const s = src();
    expect(s, 'js_fig on the manager is what survives a number being reused')
      .toMatch(/getattr\(_m,\s*['"]js_fig['"],\s*None\)\s+is\s+None/);
    // The number-keyed shape is the defect-3 bug. Guard against it coming back
    // on the main thread; the worker's own copy is out of scope here.
    const setup = s.slice(s.indexOf('var MATPLOTLIB_SETUP_CODE'),
                          s.indexOf('var CONSOLE_MODULE_CODE'));
    expect(setup, 'keying on the number silently never draws a post-close figure')
      .not.toMatch(/fig['"]?\s*\+\s*str\(|_figid|\.number\b/);
  });

  it('redraws an already-shown figure in place instead of appending or no-oping', () => {
    const s = src();
    expect(s, 'draw_idle + refresh_all pushes over the socket js_fig already holds')
      .toMatch(/_m\.canvas\.draw_idle\(\)/);
    expect(s).toMatch(/_m\.refresh_all\(\)/);
  });

  it('initializes the webagg application before showing', () => {
    // Skipping this fails the very first show with
    // "ReferenceError: mpl is not defined" — initialize() is what injects
    // mpl.css and the mpl JS the figure constructor needs. It guards on
    // cls.initialized, so calling it every time is free.
    expect(src()).toMatch(/WebAggApplication\.initialize\(\)/);
  });

  it('warns rather than raising when the backend cannot show', () => {
    // matplotlib's own pyplot_show catches NonGuiException and warns. Without
    // this, switch_backend('agg') followed by show() gives the student a
    // traceback pointing into injected code they never wrote.
    const s = src();
    expect(s).toMatch(/except\s+NonGuiException/);
    expect(s).toMatch(/warnings\.warn\(str\(_exc\)\)/);
  });

  it('leaves nothing behind in pyodide.globals', () => {
    // The Variables tab iterates that namespace, so an injected name would be
    // listed as one of the student's own. Verified in the embed: neither
    // _trinket_show nor _plt is present after a run.
    expect(src()).toMatch(/del _plt, _trinket_show/);
  });

  it('no longer asks the DOM whether anything rendered', () => {
    // g.querySelector('canvas') answers "did anything render", which is a
    // different question from "has every open figure been shown" — that is
    // defect 1. Idempotence removes the need for any guard at all.
    const s = src();
    // Matches the guard STATEMENT, not the word — the comment above the fix
    // quotes the old code on purpose, and should not fail its own test.
    expect(s, 'the DOM test is the #254 root cause')
      .not.toMatch(/if\s*\([^)]*querySelector\(['"]canvas['"]\)/);
    expect(s, 'auto-display still shows figures the program left open')
      .toMatch(/if matplotlib\.pyplot\.get_fignums\(\):/);
  });
});
