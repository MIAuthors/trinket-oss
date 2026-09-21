'use strict';
// The worker's Save path (#252) is Python embedded in a JS string array, so
// nothing in this suite type-checks it and nothing runs it. What can be pinned
// here is the structural property the fix actually rests on, plus the shape of
// the page-side half.
//
// The ordering is the load-bearing part. The {type:'save'} swallow has to come
// BEFORE `_m.handle_json(_evt)`. If it ever moves after, handle_json dispatches
// to Pyodide's patched Python handle_save first, which renders the figure and
// delivers it with document.createElement('a') -- against the worker's inert
// stub. The swallow would then still run and the file would still arrive, so
// the regression would not look like a failure: Save would appear to work while
// rendering the figure twice, once into nothing. That is precisely the kind of
// thing a human does not notice and a test does.
const fs = require('node:fs');
const path = require('node:path');

const ROOT   = path.join(__dirname, '..', '..');
const WORKER = path.join(ROOT, 'public/js/embed/pyodide-worker.js');
const PAGE   = path.join(ROOT, 'public/js/embed/pyodide.js');

/**
 * The worker source as text. Deliberately NOT evaluated: every assertion below
 * is about the order and presence of lines, which the raw source answers just
 * as well, and evaluating the MPL_SETUP array literal would break confusingly
 * the day it stops being one.
 */
function workerSource() {
  return fs.readFileSync(WORKER, 'utf8');
}

describe('worker figure save — the worker source', () => {
  const py = workerSource();

  it('swallows the save message before handle_json can dispatch it', () => {
    const swallow = py.indexOf("if _evt.get('type') == 'save':");
    const dispatch = py.indexOf('_m.handle_json(_evt)');

    expect(swallow).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(swallow).toBeLessThan(dispatch);
  });

  it('returns from the save branch rather than falling through to dispatch', () => {
    const branch = py.slice(py.indexOf("if _evt.get('type') == 'save':"),
                            py.indexOf('_m.handle_json(_evt)'));
    expect(branch).toContain('return');
  });

  it('renders with savefig, not from a canvas', () => {
    expect(py).toContain('savefig');
    expect(py).not.toContain('toDataURL');
  });

  it('reports a failed render instead of swallowing it', () => {
    const branch = py.slice(py.indexOf("if _evt.get('type') == 'save':"),
                            py.indexOf('_m.handle_json(_evt)'));
    expect(branch).toContain('save-error');
  });

  // The same silence that made #252 hard to find: matplotlib alerts on an
  // unsupported format, and a no-op stub makes that indistinguishable from a
  // successful save.
  it('routes alert() to the console rather than discarding it', () => {
    const src = fs.readFileSync(WORKER, 'utf8');
    const stub = src.slice(src.indexOf('function installDomStubs()'),
                           src.indexOf('var MPL_SETUP'));
    expect(stub).toContain('self.alert');
    expect(stub).toMatch(/self\.alert = function[^}]*stderr/s);
  });
});

// This is the half that running it actually caught. Everything above was in
// place and the button still did nothing, because worker-client scopes every
// `type: 'figure'` message to the current run and drops the rest -- and a save
// reply, by its nature, arrives after the run has settled and `current` is
// null. The scoping is right for frame data and wrong for a file.
describe('worker figure frames are scoped to the WORKER, not the run', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/embed/worker-client.js'), 'utf8');
  const branch = src.slice(src.indexOf("if (msg.type === 'figure')"),
                           src.indexOf("if (msg.type === 'scene-ops')"));

  // This block used to scope frames to `current`, the live RUN. settle() nulls
  // `current` when a program ends, so every frame after that was dropped --
  // and a matplotlib figure outlives its run. Pan, zoom, home and resize on a
  // finished plot were all handled by Python and then discarded here.
  it('does not scope frames to the current run', () => {
    expect(branch).not.toMatch(/!current \|\| msg\.id !== current\.id/);
  });

  it('drops frames from a worker that has been replaced', () => {
    expect(branch).toContain('e.target !== worker');
  });

  // Save needed its own exemption under run scoping (#252). Worker scoping
  // subsumes it: a save reply is late for the same reason an interactive frame
  // is, so the special case should be GONE rather than left as dead code.
  it('needs no special case for save replies any more', () => {
    expect(branch).not.toContain("msg.kind === 'save'");
    expect(branch).not.toContain('isSave');
  });
});

describe('worker figure save — the page half', () => {
  const src = fs.readFileSync(PAGE, 'utf8');

  it('handles the save and save-error kinds the worker sends', () => {
    expect(src).toContain("msg.kind === 'save'");
    expect(src).toContain("msg.kind === 'save-error'");
  });

  // The worker's reply is not a trusted source for this: MPL_SETUP and the
  // student's program share pyodide.globals, so student Python can call
  // _trinket_mpl_send and pick the string that lands in `download`.
  it('constrains the extension it puts in the download filename', () => {
    expect(src).toMatch(/\[a-z0-9\]\{1,5\}/);
    expect(src).not.toContain("'plot.' + (saved.format");
  });

  // Pyodide's patched mpl.js does not call ondownload, but the patch is theirs
  // and not ours. If a future Pyodide restores the call, this must not quietly
  // become a canvas grab -- toDataURL ignores savefig.dpi, .transparent and
  // .bbox_inches, so a student who set dpi=300 would get screen pixels.
  it('does not grab the canvas anywhere', () => {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toContain('toDataURL');
  });
});

// The plot-style panel's Save PNG reaches the SAME savefig round trip, because
// on the worker runtime it has no backend of its own and asks the host instead
// (plotpolish #30, answered from v0.3.5). The one thing that must not happen
// here is the substitution the describe above exists to prevent: if this
// reached for the canvas or the <img> first, the Save tab's savefig.dpi,
// transparent and bbox would stop applying on the runtime the panel is FOR.
describe('worker figure save — the plot-style panel reaches the same route', () => {
  const src  = fs.readFileSync(PAGE, 'utf8');
  const body = src.slice(src.indexOf('function requestWorkerFigureSave'),
                         src.indexOf('function runInWorker'));

  it('defines the entry point the adapter is handed', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(src).toContain('saveFigure :');
    expect(src).toContain('requestWorkerFigureSave(format)');
  });

  it('sends the same {type:\'save\'} message the mpl toolbar sends', () => {
    expect(body).toContain("type: 'save'");
    expect(body).toContain('figure_id');
  });

  // There is deliberately NO <img> fallback. An earlier version had one, on
  // the theory that mpl.js failing to load leaves a static PNG to download --
  // but `self.__trinket_worker_figure`, the only thing that posts `kind:'png'`,
  // has no caller anywhere in the repo, so the <img> is never painted. Dead
  // code defended by a paragraph that was not true. If someone revives the
  // sender, revive the fallback deliberately rather than by accident.
  it('builds no download of its own -- the socket route is the only route', () => {
    const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toContain('createElement');
    expect(code).not.toContain('download');
    expect(code).not.toContain('img.worker-figure');
  });

  it('has no orphan sender revived behind its back', () => {
    // If this ever fails, __trinket_worker_figure gained a caller and the
    // fallback question is open again -- which is exactly when someone should
    // be made to think about it.
    const worker = fs.readFileSync(WORKER, 'utf8');
    // AT MOST the definition. Not `=== 1`: that also failed when the orphan
    // was DELETED, which is the cleanup this branch explicitly defers and
    // endorses -- a test that fires on the fix it recommends is a trap, and
    // `expected 0 to be 1` points at nothing useful. It also fired on a mere
    // comment mentioning the name, so the follow-up could not leave a note.
    const hits = worker.split('__trinket_worker_figure').length - 1;
    expect(hits).toBeLessThan(2);
  });

  // The format the panel asks for reaches savefig, so a guard that inverts on
  // its own default is worse than none: it would send the nine-character
  // string "undefined" to matplotlib.
  it('defaults a missing format to png rather than to the string "undefined"', () => {
    // The expression as written, evaluated -- source text cannot tell a guard
    // from a guard-shaped string, and that is exactly how the bug shipped.
    const line = body.slice(body.indexOf('var fmt ='), body.indexOf('var ids'));
    const fmtOf = new Function('format', line + '; return fmt;');
    expect(fmtOf(undefined)).toBe('png');
    expect(fmtOf(null)).toBe('png');
    expect(fmtOf('')).toBe('png');
    expect(fmtOf('PDF')).toBe('pdf');
    expect(fmtOf('svg;')).toBe('png');
    expect(fmtOf('toolongformat')).toBe('png');
  });

  // The socket's ANSWER, not "send() did not throw". With no worker the frame
  // is dropped in silence and nothing throws, so a bare `return true` told the
  // panel to say "Saved" over a message that went nowhere. Source-text, which
  // is a weak instrument -- worker-client.test.js drives the real module for
  // the half that can actually be executed.
  it('returns what the socket said, rather than true for "did not throw"', () => {
    expect(body).toMatch(/if \(entry\.socket\.send\([^)]*\) !== true\) return false;/);
    expect(body).not.toMatch(/entry\.socket\.send\([^)]*\);\s*\n\s*return true;/);
  });

  // The panel calls preventDefault() only on a true return, so a false here is
  // what makes it tell the student the truth rather than claim a save.
  it('falls through to false when there is nothing to save', () => {
    // The LAST return in the function, not merely a `return false` somewhere:
    // the early ones are the socket's catch. If the fall-through ever becomes
    // `return true`, the panel claims a save on a run that produced no figure.
    const lastReturn = body.slice(body.lastIndexOf('return '));
    expect(lastReturn.startsWith('return false;')).toBe(true);
  });
});

/**
 * The save chain has THREE links and a source reading only ever pins two.
 *
 * A round-2 review mutated the middle one -- makeMplSocket's `send` ignoring
 * the client's answer and returning true -- and the whole 558-test suite
 * stayed green while the original bug was fully restored: after a Stop the
 * panel says "Saved" and no file appears. So these EXECUTE the links instead,
 * using the same extract-and-run idiom as mpl-resize-debounce.test.js.
 */
describe('worker figure save — the chain, executed', () => {
  const SRC = path.join(ROOT, 'public/js/embed/pyodide.js');
  function extract(name) {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error('unbalanced braces extracting ' + name);
  }

  // --- LINK 2: the socket passes the client's answer through -------------
  function socketWith(client) {
    const make = new Function('window', 'workerClient',
      'return (' + extract('makeMplSocket') + ')')({}, client);
    return make('fig1');
  }

  it('the socket returns false when the client says it did not post', () => {
    expect(socketWith({ sendMplEvent: () => false }).send({ type: 'save' })).toBe(false);
  });
  it('the socket returns true when the client posted', () => {
    expect(socketWith({ sendMplEvent: () => true }).send({ type: 'save' })).toBe(true);
  });
  it('the socket returns false when there is no client at all', () => {
    expect(socketWith(null).send({ type: 'save' })).toBe(false);
  });

  // --- LINK 3 + the in-flight state, which lives in this file now --------
  function sandbox(sendResult) {
    const sent = [];
    const out = [];
    const figures = {
      fig1: { socket: { send: () => true } },
      fig2: { socket: { send: (m) => { sent.push(m); return sendResult; } } },
    };
    const api = new Function(
      'mplFigures', 'writeOut', 'MPL_SAVE_TIMEOUT_MS', 'setTimeout', 'clearTimeout',
      'var mplSaveInFlight = false, mplSaveWatchdog = null;' +
      extract('clearMplSaveWait') +
      extract('requestWorkerFigureSave') +
      'return { save: requestWorkerFigureSave, clear: clearMplSaveWait,' +
      '         inFlight: function () { return mplSaveInFlight; } };'
    )(figures, (t) => out.push(t), 10000, setTimeout, clearTimeout);
    return { api, sent, out };
  }

  it('reports the socket\'s refusal rather than claiming a save', () => {
    const { api, out } = sandbox(false);
    expect(api.save('png')).toBe(false);
    expect(api.inFlight()).toBe(false);   // nothing left armed
    expect(out).toEqual([]);
  });

  it('takes the save, and answers a second request while one is out', () => {
    const { api, sent } = sandbox(true);
    expect(api.save('png')).toBe(true);
    expect(api.inFlight()).toBe(true);
    // True, not suppressed-and-lied-about: the student's request is satisfied
    // by the save already running, and the worker is asked only once.
    expect(api.save('png')).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('is askable again once the reply has cleared the wait', () => {
    const { api, sent } = sandbox(true);
    api.save('png');
    api.clear();                           // what the 'save' / 'save-error' branches do
    expect(api.inFlight()).toBe(false);
    api.save('png');
    expect(sent.length).toBe(2);
  });

  // The default figure choice: the LAST key, not the first. Round 1 flagged
  // that `ids[0]` passed the whole suite; this is the assertion that closes it.
  // Source-text, deliberately: stopCode() reaches half the module's state and
  // cannot be lifted out the way the two above can. Presence-and-ordering is
  // what text answers well, and that is exactly the question here -- the save
  // wait must be cleared BEFORE the worker is terminated, or a Save click in
  // the seconds after a Stop is swallowed as a duplicate of a save that can
  // never be answered, and the panel says "Saved".
  it('a Stop clears the save wait, before it terminates the worker', () => {
    const page = fs.readFileSync(PAGE, 'utf8');
    const stop = page.slice(page.indexOf('function stopCode('));
    const clearAt = stop.indexOf('clearMplSaveWait()');
    const stopAt  = stop.indexOf('workerClient.stop()');
    expect(clearAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(stopAt);
  });

  it('asks the last figure, not the first', () => {
    const { api, sent } = sandbox(true);
    api.save('png');
    expect(sent[0].figure_id).toBe('fig2');
  });
});
