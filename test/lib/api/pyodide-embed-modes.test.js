'use strict';

// #8 render-level guard. The embed controller (lib/controllers/trinket.js `embed`)
// derives the display mode from config.app.outputOnly / config.app.toggleCode by
// the URL lang, and the template stamps a body class (lib/views/embed/base.html:
// `class="mode-{output|toggle|standard}..."`). After giving pyodide
// python3-parity in those config lists, a pyodide embed must honor the
// display-mode query params and render the matching mode class.
//
// This is the SERVER-RENDER half. Whether the client JS actually hides the
// editor pane is out of scope (and note: outputOnly WITHOUT autorun renders a
// blank pane for both pyodide and python3 — a pre-existing shared-runner issue,
// tracked separately at PICUP-Physics/trinket-oss#66, not a #8 regression).

const flow   = require('../../helpers/flow.cjs');
const config = require('config');

describe('pyodide embed display modes (#8)', () => {
  let pyId;

  // pyodide is enabled by default; guard so the /embed/pyodide route serves even
  // if a future default flips the flag.
  let pyodideWasEnabled;
  beforeEach(() => {
    pyodideWasEnabled = config.features.trinkets.pyodide;
    config.features.trinkets.pyodide = true;
  });
  afterEach(() => {
    config.features.trinkets.pyodide = pyodideWasEnabled;
  });

  // Fresh user + pyodide trinket per test (the harness wipes the DB per test).
  beforeEach(async () => {
    flow.cookies = {};
    await flow.switchUser('user');
    await flow.post('/api/trinkets', { code: 'print("hi from pyodide")', lang: 'pyodide' });
    expect(flow.lastResponse.statusCode).toEqual(200);
    expect(flow.lastResponse.body.data.lang).toEqual('pyodide');
    pyId = flow.lastResponse.body.data.id;
  });

  // GET the embed and return the display-mode class it rendered.
  async function embedMode(query) {
    await flow.get('/embed/pyodide/' + pyId + (query ? '?' + query : ''));
    expect(flow.lastResponse.statusCode).toEqual(200);
    expect(flow.lastContentType).toContain('text/html');
    const m = flow.lastResponse.text.match(/class="mode-(output|toggle|standard)\b/);
    return m ? m[1] : '(no display-mode class)';
  }

  it('default pyodide embed renders mode-standard', async () => {
    expect(await embedMode('')).toEqual('standard');
  });

  it('?outputOnly=true renders mode-output', async () => {
    expect(await embedMode('outputOnly=true')).toEqual('output');
  });

  it('?toggleCode=true renders mode-toggle', async () => {
    expect(await embedMode('toggleCode=true')).toEqual('toggle');
  });
});
