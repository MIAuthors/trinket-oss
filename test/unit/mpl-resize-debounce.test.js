'use strict';
// The worker figure's resize path: the fake socket's readyState, and the
// trailing debounce over mpl.js's request_resize.
//
// Both are extracted and EXECUTED rather than read. The bug being fixed here
// was invisible to a source reading twice over: first `readyState` was simply
// absent, so a gate nobody had noticed dropped every resize; then the debounce
// that made the gate affordable created a timer that could outlive its figure.
// Neither shows up in a diff as anything other than correct-looking code.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'public/js/embed/pyodide.js');

function source() { return fs.readFileSync(SRC, 'utf8'); }

/** Lift one top-level `function name(...) { ... }` out of the embed source. */
function extract(name) {
  const src = source();
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in pyodide.js');
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

describe('the fake mpl socket', () => {
  it('carries readyState 1, which is the only thing gating a resize', () => {
    // mpl.js: `if (fig.ws.readyState == 1 && width != 0 && height != 0)`.
    // Without this property the comparison is `undefined == 1` and
    // request_resize is unreachable — the whole defect, in one absent key.
    const make = new Function('window', 'return (' + extract('makeMplSocket') + ')')({});
    const sock = make('fig1');
    expect(sock.readyState).toBe(1);
    // eslint-disable-next-line eqeqeq
    expect(sock.readyState == 1).toBe(true);
  });
});

/**
 * Build a sandbox holding the real debounceMplResize plus the generation
 * counter it reads, and hand back the levers the tests need.
 */
function sandbox() {
  const body = extract('debounceMplResize');
  const calls = [];
  const win = { mpl: { figure: function () {} } };
  win.mpl.figure.prototype.request_resize = function (w, h) { calls.push([this, w, h]); };
  const ctx = new Function('window', `
    var mplGeneration = 0;
    ${body}
    return {
      arm: debounceMplResize,
      bump: function () { mplGeneration++; },
      proto: window.mpl.figure.prototype
    };
  `)(win);
  ctx.arm();
  return { ctx, calls, fig: Object.create(win.mpl.figure.prototype) };
}

describe('the resize debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collapses a drag into ONE request, at the size the pointer stopped at', () => {
    // Undebounced, mpl.js's ResizeObserver fires once per animation frame and
    // each request costs the worker a full Agg render plus a PNG encode.
    const { calls, fig } = sandbox();
    for (const [w, h] of [[100, 80], [200, 160], [300, 240], [640, 460]]) {
      fig.request_resize(w, h);
      vi.advanceTimersByTime(16);
    }
    expect(calls.length).toBe(0);          // nothing yet: trailing, not leading
    vi.advanceTimersByTime(150);
    expect(calls.length).toBe(1);
    expect(calls[0].slice(1)).toEqual([640, 460]);
  });

  it('drops a request whose figures were torn down while it waited', () => {
    // "Drag the corner, then hit Run" lands inside the 150 ms window. Worker
    // figure ids are reused (`fig1` every run), so a stale request would be
    // applied to the NEW run's manager.
    const { ctx, calls, fig } = sandbox();
    fig.request_resize(640, 460);
    ctx.bump();                            // what resetMplFigures() does
    vi.advanceTimersByTime(500);
    expect(calls.length).toBe(0);
  });

  it('still delivers when nothing was torn down', () => {
    const { calls, fig } = sandbox();
    fig.request_resize(640, 460);
    vi.advanceTimersByTime(500);
    expect(calls.length).toBe(1);
  });

  it('wraps request_resize exactly once, however many figures arrive', () => {
    const { ctx, calls, fig } = sandbox();
    const wrapped = ctx.proto.request_resize;
    ctx.arm(); ctx.arm();
    expect(ctx.proto.request_resize).toBe(wrapped);
    fig.request_resize(1, 2);
    vi.advanceTimersByTime(500);
    expect(calls.length).toBe(1);          // not once per arm() call
  });
});

describe('the teardown sites', () => {
  it('go through resetMplFigures(), so the generation cannot drift', () => {
    // A bare `mplFigures = {}` added later would clear the figures without
    // bumping the generation, and stale resizes would come back.
    const src = source();
    const bare = src.split('\n').filter(
      (l) => /^\s*mplFigures\s*=\s*\{\s*\}/.test(l) && !/function resetMplFigures/.test(l));
    expect(bare.length).toBe(1);           // only the one inside resetMplFigures
    expect(src).toContain('function resetMplFigures()');
  });
});
