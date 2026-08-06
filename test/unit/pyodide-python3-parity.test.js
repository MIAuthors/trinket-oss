'use strict';

// pyodide and python3 run on the SAME client-side Pyodide runtime
// (lib/views/embed/python3.html extends embed/pyodide.html), so they must expose
// identical embed/display capabilities. When they diverged, pyodide trinkets'
// Share -> Embed dialog showed NO presentation options (MIAuthors #8): the embed
// controller (lib/controllers/trinket.js) gates displayOption / outputOnly /
// toggleCode / configurable / downloadable / runOption on
// `config.app.<list>.indexOf(lang) >= 0`, and pyodide was in none of the lists
// while python3 was in all of them. This pins the parity so a capability added
// for one Python engine isn't silently withheld from the other.

const config = require('config');

// Every config.app membership list that gates a per-lang capability.
const ARRAY_LISTS = [
  'autorun', 'outputOnly', 'toggleCode', 'toggleEditor',
  'downloadable', 'uploadable', 'configurable', 'nodraft',
  'notShareable', 'hideGeneratedCode'
];

describe('config.app: pyodide has python3-parity capabilities', () => {
  ARRAY_LISTS.forEach((list) => {
    it(`list '${list}': pyodide membership matches python3`, () => {
      const arr = config.app[list] || [];
      expect(arr.indexOf('pyodide') >= 0).toBe(arr.indexOf('python3') >= 0);
    });
  });

  it('runOption: pyodide is configured identically to python3', () => {
    const ro = config.app.runOption || {};
    expect(ro.pyodide).toEqual(ro.python3);
  });
});
