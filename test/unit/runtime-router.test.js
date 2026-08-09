'use strict';
// #108: chooseRuntime decides, per program, whether to run in the Web Worker or
// on the main thread. It is pure so the rules can be tested without a browser.
const { chooseRuntime, hasUnawaitableCall } = require('../../public/js/embed/runtime-router.js');

const OPTS = { usesVPython: false, workerEnabled: true, queryRuntime: undefined };

describe('chooseRuntime', () => {
  it('sends an ordinary program to the worker', () => {
    const r = chooseRuntime('print("hi")', OPTS);
    expect(r.runtime).toBe('worker');
  });

  it('keeps VPython on the main thread', () => {
    const r = chooseRuntime('from vpython import *\nsphere()', { ...OPTS, usesVPython: true });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/vpython/i);
  });

  it('keeps a program on the main thread when the worker is disabled', () => {
    const r = chooseRuntime('print("hi")', { ...OPTS, workerEnabled: false });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/disabled/i);
  });

  it('honours ?runtime=main as an escape hatch', () => {
    const r = chooseRuntime('print("hi")', { ...OPTS, queryRuntime: 'main' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/query/i);
  });

  it('honours ?runtime=worker even when the config flag is off', () => {
    const r = chooseRuntime('print("hi")', { ...OPTS, workerEnabled: false, queryRuntime: 'worker' });
    expect(r.runtime).toBe('worker');
  });

  it('VPython beats ?runtime=worker — the bridge cannot run off-thread', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, queryRuntime: 'worker' });
    expect(r.runtime).toBe('main');
  });

  it('always returns a reason string', () => {
    expect(typeof chooseRuntime('print(1)', OPTS).reason).toBe('string');
    expect(chooseRuntime('print(1)', OPTS).reason.length).toBeGreaterThan(0);
  });
});

describe('hasUnawaitableCall', () => {
  it('flags input() inside a list comprehension', () => {
    expect(hasUnawaitableCall('xs = [input() for _ in range(3)]')).toBe(true);
  });

  it('flags input() inside a lambda', () => {
    expect(hasUnawaitableCall('f = lambda: input()')).toBe(true);
  });

  it('flags sleep() inside a comprehension', () => {
    expect(hasUnawaitableCall('[sleep(1) for _ in range(3)]')).toBe(true);
  });

  it('does NOT flag an ordinary input() call', () => {
    expect(hasUnawaitableCall('name = input("who? ")')).toBe(false);
  });

  it('does NOT flag input() inside a def (the transform handles that)', () => {
    expect(hasUnawaitableCall('def ask():\n    return input()')).toBe(false);
  });

  it('does NOT flag the word input in a string or comment', () => {
    expect(hasUnawaitableCall('print("[input() for x in y]")')).toBe(false);
    expect(hasUnawaitableCall('# [input() for x in y]')).toBe(false);
  });

  it('routes an unawaitable program to the main thread', () => {
    const r = chooseRuntime('xs = [input() for _ in range(3)]', OPTS);
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/comprehension|lambda/i);
  });

  // --- deliberate conservatism, recorded so it is not "fixed" the wrong way ---
  // The scan asks whether one bracketed span holds BOTH a `for` and an awaitable
  // call. That over-matches when a call and an unrelated comprehension are
  // arguments to the same expression. The error is in the SAFE direction: the
  // program runs on the main thread, exactly as it does today, and merely loses
  // freeze protection. A false NEGATIVE would be the harmful one — it would send
  // a program to the worker where `await` cannot be inserted, and it would hang.
  it('over-matches a call beside an unrelated comprehension (safe direction)', () => {
    expect(hasUnawaitableCall('print(input(), [x for x in y])')).toBe(true);
    expect(chooseRuntime('print(input(), [x for x in y])', OPTS).runtime).toBe('main');
  });

  it('does not over-match across separate statements', () => {
    expect(hasUnawaitableCall('name = input()\nys = [x for x in y]')).toBe(false);
  });
});
