'use strict';
// #108: message SHAPES only. Live worker behaviour is covered by
// test/browser/specs/worker-runtime.spec.js against a real stack — a fake Worker
// plus a fake Pyodide would only test the fakes.
const { buildRunReply, PROTOCOL_VERSION } = require('../../public/js/embed/pyodide-worker.js');

describe('worker protocol', () => {
  it('declares a protocol version so a stale cached worker is detectable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('builds a done reply carrying the run id', () => {
    expect(buildRunReply('r1', { ok: true })).toEqual({ type: 'done', id: 'r1' });
  });

  it('builds an error reply carrying the RAW traceback (the page formats it)', () => {
    const reply = buildRunReply('r2', { ok: false, traceback: 'Traceback...\nValueError: x' });
    expect(reply).toEqual({ type: 'error', id: 'r2', traceback: 'Traceback...\nValueError: x' });
  });

  it('does not format the traceback itself — that is the page\'s job (#107)', () => {
    // The page owns formatPythonTraceback + escapeConsoleHtml. If the worker
    // started trimming frames, the two runtimes would drift apart.
    const raw = 'Traceback (most recent call last):\n  File "/lib/python313.zip/x.py", line 1\nValueError: x';
    expect(buildRunReply('r3', { ok: false, traceback: raw }).traceback).toBe(raw);
  });
});
