'use strict';
// The worker figure manager's toolbar.
//
// `FigureManagerWebAgg` in `backend_webagg_core` has `_toolbar2_class = None`;
// it is `backend_webagg` — the server-backed variant Trinket does not use —
// that sets it. So the manager built here had no toolbar object,
// `handle_toolbar_button` did `getattr(None, name)()`, and the resulting
// AttributeError was swallowed by the empty `except` around the event
// dispatch. Home, Back, Forward, Pan and Zoom took the click and did nothing,
// silently, with nothing in the console.
//
// WHAT THIS FILE CAN AND CANNOT DO. These are assertions about the worker's
// Python SOURCE, not an end-to-end check that Home works: the failure lives in
// a Python AttributeError, inside Pyodide, inside a Web Worker, which the node
// environment cannot reach. Proving the button works needs a deploy spec of the
// shape #273 took for the step debugger.
//
// What they do buy is the thing the existing browser test cannot: that spec
// asserts the frontend renders at least five toolbar buttons, and mpl.js builds
// those buttons independently of Python — so it would stay green if
// `_toolbar2_class` regressed to None, or if the construction site went back to
// the base class. Both of those fail here.
const fs = require('node:fs');
const path = require('node:path');

const WORKER = path.join(__dirname, '..', '..', 'public/js/embed/pyodide-worker.js');
const py = fs.readFileSync(WORKER, 'utf8');

describe('worker matplotlib toolbar — the worker source', () => {
  it('subclasses the manager to set _toolbar2_class, which the base leaves None', () => {
    const cls = py.indexOf('class _TrinketFigureManager(_wac.FigureManagerWebAgg):');
    const attr = py.indexOf('_toolbar2_class = _wac.NavigationToolbar2WebAgg');
    expect(cls).toBeGreaterThan(-1);
    expect(attr).toBeGreaterThan(cls);
  });

  it('constructs the SUBCLASS, not the base — the other shape this regresses in', () => {
    expect(py).toContain('_manager = _TrinketFigureManager(_canvas, _num)');
    // A bare construction anywhere is the regression: the class can keep
    // existing while the call site quietly goes back to the base.
    expect(py).not.toContain('_wac.FigureManagerWebAgg(');
  });

  it('defines the class before the loop that constructs it', () => {
    // The manager is built inside a per-figure loop in MPL_SETUP; a definition
    // placed after it would raise NameError on the first figure, which the same
    // empty `except` would swallow just as quietly as the original bug.
    expect(py.indexOf('class _TrinketFigureManager('))
      .toBeLessThan(py.indexOf('_manager = _TrinketFigureManager('));
  });

  it('takes the toolbar class from _wac, the module the manager comes from', () => {
    // NavigationToolbar2WebAgg lives in backend_webagg_core alongside the
    // manager. Importing it from backend_webagg instead would pull in the
    // server-backed variant, which is what this whole file exists to avoid.
    expect(py).toContain('_toolbar2_class = _wac.NavigationToolbar2WebAgg');
    expect(py).not.toContain('from matplotlib.backends.backend_webagg import');
  });
});
