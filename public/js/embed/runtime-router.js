(function(root) {
  'use strict';

  // #108: which runtime should THIS program use?
  //
  // Kept pure — no DOM, no Pyodide, no config lookups — so every rule can be
  // tested in node. pyodide.js is already large; putting the rules there would
  // make them reachable only through a browser.

  // Calls the async transform rewrites to `await`. Inside a lambda or a
  // comprehension it CANNOT (neither can be async), and _async_transform.py
  // documents that as a known limitation. Such a program must stay on the main
  // thread, where these calls are synchronous and still work.
  var AWAITABLE = ['input', 'sleep', 'rate'];

  // Strip comments and string literals before scanning, so `print("[input() ...]")`
  // is not mistaken for a real comprehension.
  function stripLiterals(src) {
    return String(src || '')
      .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/#[^\n]*/g, '');
  }

  // True when an awaitable call appears inside a lambda body or a comprehension.
  function hasUnawaitableCall(src) {
    var code = stripLiterals(src);
    var names = AWAITABLE.join('|');

    // lambda ... : ... input() ...   (up to the end of the line)
    if (new RegExp('\\blambda\\b[^\\n:]*:[^\\n]*\\b(?:' + names + ')\\s*\\(').test(code)) {
      return true;
    }

    // [ ... input() ... for ... ] — a bracketed span containing BOTH a `for` and
    // an awaitable call is a comprehension using one.
    //
    // This needs a depth-tracking scan, not a regex: `[input() for _ in xs]`
    // contains `()` inside the `[]`, so a pattern that forbids nested brackets
    // never matches the span that matters — and a call is nested by definition,
    // which is the only case worth detecting.
    var callRe = new RegExp('\\b(?:' + names + ')\\s*\\(');
    var stack = [];
    for (var i = 0; i < code.length; i++) {
      var ch = code.charAt(i);
      if (ch === '[' || ch === '(' || ch === '{') {
        stack.push(i);
      } else if (ch === ']' || ch === ')' || ch === '}') {
        var start = stack.pop();
        if (start === undefined) continue;
        var inner = code.slice(start + 1, i);
        if (/\bfor\b/.test(inner) && callRe.test(inner)) return true;
      }
    }
    return false;
  }

  // options: { usesVPython, workerEnabled, workerVPython, queryRuntime }
  function chooseRuntime(source, options) {
    var opts = options || {};

    // Opt-in (spec 2026-08-10 V1/V2): vpython-jupyter in the worker. The FLAG is
    // the only gate — ?runtime=worker must not opt a class in by URL — but
    // ?runtime=main still escapes, so it is checked inline here rather than by
    // the query rules below, which this rule sits above.
    //
    // The lambda/comprehension guard is checked inline for the same reason, and
    // it matters MORE here than on the python3 path. There, an un-awaited
    // `rate()` is a call that simply happens synchronously. In a vpython worker
    // run `rate`/`sleep` are coroutine FACTORIES: an un-awaited call constructs a
    // coroutine and drops it — no flush, no pacing, no yield to the event loop.
    // So the flag would turn a program that works on the main thread into one
    // that renders nothing and spins, which is precisely the shape this guard
    // was written to keep off the worker. Falling through lands on
    // `usesVPython → main`, the right destination.
    if (opts.usesVPython && opts.workerVPython && opts.queryRuntime !== 'main' &&
        !hasUnawaitableCall(source)) {
      return { runtime: 'worker', vpython: true, reason: 'vpython: workerVPython flag routes to the worker runtime' };
    }

    // VPython first: its bridge does `from js import sphere, box, rate, …`,
    // binding synchronously to the window realm. No query parameter can
    // override that — off-thread it would simply fail to import.
    if (opts.usesVPython) {
      return { runtime: 'main', reason: 'vpython: bridge requires the window realm' };
    }

    if (opts.queryRuntime === 'main')   return { runtime: 'main',   reason: 'query: runtime=main' };
    if (opts.queryRuntime === 'worker') return { runtime: 'worker', reason: 'query: runtime=worker' };

    if (!opts.workerEnabled) {
      return { runtime: 'main', reason: 'config: worker runtime disabled' };
    }

    if (hasUnawaitableCall(source)) {
      return { runtime: 'main', reason: 'await cannot be inserted in a lambda or comprehension' };
    }

    return { runtime: 'worker', reason: 'default' };
  }

  var router = { chooseRuntime: chooseRuntime, hasUnawaitableCall: hasUnawaitableCall };

  if (typeof module !== 'undefined' && module.exports) module.exports = router;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.runtimeRouter', router);
})(typeof window !== 'undefined' ? window : this);
