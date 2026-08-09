# Pyodide Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run student Python in a Web Worker so the page never freezes and Stop can halt any program, including `while True: pass`.

**Architecture:** A routed dual runtime. A pure `chooseRuntime()` decides per program whether to use today's in-window Pyodide (VPython keeps its proven bridge) or a new Web Worker kernel. The worker never touches the DOM; everything crosses one typed `postMessage` channel.

**Tech Stack:** Pyodide, Web Workers, `postMessage`, vitest (node unit tests), Playwright (browser specs), nunjucks templates, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-08-pyodide-worker-runtime-design.md` — read it before Task 1.

## Global Constraints

- **Branch from `smoke/phase1-2`, not `picup/main`.** The plan reuses `formatPythonTraceback()`, `escapeConsoleHtml()`, `usesVPython()`, the REPL, and the `.stop-it` button. Only `smoke/phase1-2` has all of them.
- **No `SharedArrayBuffer` and no `Atomics.wait`.** Embeds can never be cross-origin isolated. Every worker interaction is asynchronous.
- **The worker never references `document`, `window`, or GlowScript.** It has `self` only.
- **Never reimplement output handling.** Tracebacks go through the existing `formatPythonTraceback(msg, mainName)` then `escapeConsoleHtml(text)`; console writes go through `writeOut(text)`.
- **VPython behaviour must not change.** `usesVPython(source)` programs stay on the main thread.
- **Default off.** `config.features.workerRuntime: false` and opt-in `?runtime=worker` until the trials are clean.
- **Protocol message type strings are fixed** by the spec: `init`, `run`, `stdin-reply`, `mpl-event`, `snapshot`, `record`, `expand`, `scene-event` (page→worker); `ready`, `stdout`, `stderr`, `input-request`, `figure`, `done`, `error`, `snapshot-result`, `record-result`, `expand-result`, `scene-ops` (worker→page).
- **Commit messages** end with the two trailers used throughout this repo:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01G7y9rTA1r8r8EhEnPSQenR`.

## Environment

- Node unit tests: `npm test` (vitest). On **intelmini you must mask `config/local.yaml` first** or the mongoose profile fails.
- Browser specs: bring the stack up with `docker compose -f docker-compose.gcr.yml up -d --build`, then `cd test/browser && npx playwright test specs/<file>`.
  **Do not run `test/browser/run-smoke.sh`** — it runs `docker compose down` on exit and will tear down a stack someone may be using.
- After editing any file under `public/js/`, you **must rebuild the container** before browser specs see the change: `docker compose -f docker-compose.gcr.yml up -d --build`.
- `bash scripts/build-info.sh` before a rebuild keeps `/version` honest.

---

## Deviations from the spec

Two places where this plan deliberately builds less than the spec describes.
Both are staged, not abandoned, and both reuse the same message so nothing is
throwaway. Raise them with Steve before starting if you disagree.

| Spec | Plan | Why |
|---|---|---|
| §8 / D4 — matplotlib uses `backend_webagg_core` for interactive figures | Task 7 ships **static PNG** over the same `figure` message; interactive is a follow-up | The `mpl.js` client is version-coupled to Pyodide's matplotlib and is the single largest piece of the project. Proving the channel end to end first makes the interactive upgrade a payload change, which is exactly what the spec's own seam was designed for. |
| §8a — explorer **and** step debugger over the channel | Task 8 does the **explorer** only; `record`/`expand` are deferred | The explorer is one post-run message and closes the site-config problem D6 identified. The step debugger's replay UI is large and has no equivalent urgency; its messages are the same shape, so it is additive later. |

Everything else in the spec has a task.

---

## File Structure

| File | Responsibility |
|---|---|
| `public/js/embed/runtime-router.js` | **Create.** Pure `chooseRuntime()`. UMD so vitest can `require()` it. No DOM, no Pyodide. |
| `public/js/embed/pyodide-worker.js` | **Create.** The worker kernel. Owns Pyodide, runs code, emits messages. Never touches the DOM. |
| `public/js/embed/worker-client.js` | **Create.** Page side: spawn, message routing, lifecycle, pre-warm. |
| `public/js/embed/pyodide.js` | **Modify.** Delegate to the client when routed to the worker. Main-thread path untouched. |
| `lib/views/embed/pyodide.html` | **Modify.** Add the new scripts to both `cachify_js` lists. |
| `config/default.yaml` | **Modify.** Add `features.workerRuntime: false`. |
| `test/unit/runtime-router.test.js` | **Create.** Node tests for every routing rule. |
| `test/browser/specs/worker-runtime.spec.js` | **Create.** Browser tests for Stop, input, figures, explorer. |

The router is a separate file precisely because it is the only cheaply-testable piece; keeping it out of `pyodide.js` (already ~2400 lines) is what makes the routing rules testable at all.

---

## Task 1: The routing predicate

**Files:**
- Create: `public/js/embed/runtime-router.js`
- Test: `test/unit/runtime-router.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `chooseRuntime(source, options)` → `{ runtime: 'main'|'worker', reason: string }`.
  `options` is `{ usesVPython: boolean, workerEnabled: boolean, queryRuntime: string|undefined }`.
  Also exports `hasUnawaitableCall(source)` → `boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/runtime-router.test.js`:

```javascript
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/runtime-router.test.js`
Expected: FAIL — `Cannot find module '../../public/js/embed/runtime-router.js'`.

- [ ] **Step 3: Write the implementation**

Create `public/js/embed/runtime-router.js`. The UMD tail matches `public/js/library/trinkets/list/selection-model.js`, the existing pattern in this repo.

```javascript
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

    // [ ... input() ... for ... ]  /  { ... }  /  ( ... ) — a bracketed span that
    // contains BOTH a `for` and an awaitable call is a comprehension using one.
    var bracket = /[\[\{\(]([^\[\]\{\}\(\)]*)[\]\}\)]/g;
    var m;
    while ((m = bracket.exec(code)) !== null) {
      var inner = m[1];
      if (/\bfor\b/.test(inner) && new RegExp('\\b(?:' + names + ')\\s*\\(').test(inner)) {
        return true;
      }
    }
    return false;
  }

  // options: { usesVPython, workerEnabled, queryRuntime }
  function chooseRuntime(source, options) {
    var opts = options || {};

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/runtime-router.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the whole unit suite for regressions**

Run: `npm test`
Expected: no new failures. (On intelmini, mask `config/local.yaml` first.)

- [ ] **Step 6: Commit**

```bash
git add public/js/embed/runtime-router.js test/unit/runtime-router.test.js
git commit -m "feat(#108): pure chooseRuntime() predicate for the worker runtime"
```

---

## Task 2: The worker kernel — run, output, errors

**Files:**
- Create: `public/js/embed/pyodide-worker.js`
- Test: `test/unit/pyodide-worker-protocol.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a worker script handling `init` and `run`, replying `ready`, `stdout`, `stderr`, `done`, `error`.
  Exports (for tests only, via the same UMD tail) `buildRunReply(id, result)` and `PROTOCOL_VERSION = 1`.

**Note on testing:** a real Worker plus a real Pyodide boot cannot run in vitest. This task unit-tests only the pure message-shaping helpers; the live behaviour is covered by Task 6's browser spec. Do not fake a Worker — a mock would test the mock.

- [ ] **Step 1: Write the failing test**

Create `test/unit/pyodide-worker-protocol.test.js`:

```javascript
'use strict';
// #108: message SHAPES only. Live worker behaviour is covered by
// test/browser/specs/worker-runtime.spec.js against a real stack.
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/pyodide-worker-protocol.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `public/js/embed/pyodide-worker.js`:

```javascript
(function(root) {
  'use strict';

  // #108: the Pyodide kernel, off the main thread.
  //
  // This file must NEVER reference `document`, `window`, or GlowScript — it has
  // `self` only. Anything visual crosses the channel as a message and is
  // rendered by the page.
  //
  // Stop is not implemented here. The page calls worker.terminate(), which is
  // unconditional and therefore works for `while True: pass` — the case
  // cooperative cancellation can never reach.

  var PROTOCOL_VERSION = 1;

  // Pure so it can be unit-tested; the live path is a browser spec.
  function buildRunReply(id, result) {
    if (result && result.ok === false) {
      return { type: 'error', id: id, traceback: result.traceback };
    }
    return { type: 'done', id: id };
  }

  // ---- worker runtime (skipped entirely when required from node) -----------
  if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
    var pyodide = null;
    var post = function(msg) { self.postMessage(msg); };

    var boot = function(msg) {
      self.importScripts(msg.pyodideUrl);
      return self.loadPyodide().then(function(py) {
        pyodide = py;
        // Batched, exactly as the in-window runner does, so partial lines are
        // not emitted one character at a time.
        pyodide.setStdout({ batched: function(s) { post({ type: 'stdout', text: s + '\n' }); } });
        pyodide.setStderr({ batched: function(s) { post({ type: 'stderr', text: s + '\n' }); } });
        post({ type: 'ready', v: PROTOCOL_VERSION, pyodideVersion: pyodide.version });
      });
    };

    var run = function(msg) {
      return pyodide.runPythonAsync(msg.source)
        .then(function() { post(buildRunReply(msg.id, { ok: true })); })
        .catch(function(err) {
          post(buildRunReply(msg.id, { ok: false, traceback: String(err && err.message || err) }));
        });
    };

    self.onmessage = function(e) {
      var msg = e.data || {};
      try {
        if (msg.type === 'init') { boot(msg); return; }
        if (msg.type === 'run')  { run(msg);  return; }
        // Reserved types are DEFINED by the spec but not implemented in v1.
        // Answer explicitly rather than dropping the message silently.
        post({ type: 'error', id: msg.id, traceback: 'message type not supported in runtime v' + PROTOCOL_VERSION + ': ' + msg.type });
      } catch (err) {
        post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
      }
    };
  }

  var api = { buildRunReply: buildRunReply, PROTOCOL_VERSION: PROTOCOL_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/pyodide-worker-protocol.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/pyodide-worker.js test/unit/pyodide-worker-protocol.test.js
git commit -m "feat(#108): Pyodide worker kernel — run, batched output, raw tracebacks"
```

---

## Task 3: The page-side client

**Files:**
- Create: `public/js/embed/worker-client.js`
- Test: `test/unit/worker-client.test.js`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` from Task 2 (as a literal, not an import — the worker is a separate realm).
- Produces: `createWorkerClient(options)` → object with
  `run(source) → Promise`, `stop()`, `isRunning() → boolean`, `dispose()`.
  `options` is `{ workerUrl, pyodideUrl, onStdout(text), onStderr(text), onError(traceback), onReady() }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/worker-client.test.js`. It injects a fake Worker **constructor** — this tests the client's own state machine, not a mocked Pyodide.

```javascript
'use strict';
// #108: the client's lifecycle logic — correlation ids, stop, and the promise
// contract. A fake Worker constructor is injected so this stays a node test;
// real execution is covered by the browser spec.
const { createWorkerClient } = require('../../public/js/embed/worker-client.js');

function fakeWorkerFactory() {
  const made = [];
  function FakeWorker() {
    this.posted = [];
    this.terminated = false;
    this.postMessage = (m) => { this.posted.push(m); };
    this.terminate = () => { this.terminated = true; };
    made.push(this);
  }
  return { FakeWorker, made };
}

function newClient(extra) {
  const { FakeWorker, made } = fakeWorkerFactory();
  const events = { stdout: [], stderr: [], errors: [] };
  const client = createWorkerClient(Object.assign({
    workerUrl: '/js/embed/pyodide-worker.js',
    pyodideUrl: 'https://cdn/pyodide.js',
    WorkerCtor: FakeWorker,
    onStdout: (t) => events.stdout.push(t),
    onStderr: (t) => events.stderr.push(t),
    onError:  (t) => events.errors.push(t)
  }, extra || {}));
  return { client, made, events };
}

describe('createWorkerClient', () => {
  it('sends init on construction', () => {
    const { made } = newClient();
    expect(made[0].posted[0].type).toBe('init');
  });

  it('is not running before a run starts', () => {
    const { client } = newClient();
    expect(client.isRunning()).toBe(false);
  });

  it('posts a run message with a correlation id, and reports running', () => {
    const { client, made } = newClient();
    client.run('print(1)');
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.source).toBe('print(1)');
    expect(typeof runMsg.id).toBe('string');
    expect(client.isRunning()).toBe(true);
  });

  it('forwards stdout to the callback', () => {
    const { client, made, events } = newClient();
    client.run('print(1)');
    made[0].onmessage({ data: { type: 'stdout', text: 'hello\n' } });
    expect(events.stdout).toEqual(['hello\n']);
  });

  it('resolves the run promise on done', async () => {
    const { client, made } = newClient();
    const p = client.run('print(1)');
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id } });
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('reports an error and still settles the run', async () => {
    const { client, made, events } = newClient();
    const p = client.run('boom');
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'error', id, traceback: 'ValueError: x' } });
    await p;
    expect(events.errors).toEqual(['ValueError: x']);
    expect(client.isRunning()).toBe(false);
  });

  it('ignores replies whose id does not match the current run (a stale worker)', async () => {
    const { client, made, events } = newClient();
    client.run('print(1)');
    made[0].onmessage({ data: { type: 'error', id: 'not-the-current-id', traceback: 'stale' } });
    expect(events.errors).toEqual([]);
    expect(client.isRunning()).toBe(true);
  });

  it('stop() terminates the worker and settles the in-flight run', async () => {
    const { client, made } = newClient();
    const p = client.run('while True: pass');
    client.stop();
    expect(made[0].terminated).toBe(true);
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('spawns a replacement worker after stop, so the next run works', () => {
    const { client, made } = newClient();
    client.run('while True: pass');
    client.stop();
    client.run('print(2)');
    expect(made.length).toBe(2);
    expect(made[1].posted[0].type).toBe('init');
  });

  it('stop() with nothing running is harmless', () => {
    const { client } = newClient();
    expect(() => client.stop()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/worker-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `public/js/embed/worker-client.js`:

```javascript
(function(root) {
  'use strict';

  // #108: page side of the worker channel. Owns the worker's lifecycle and
  // correlates replies to runs.
  //
  // Stop is worker.terminate() — unconditional, and the whole reason this
  // exists. A terminated worker cannot be reused, so a replacement is created
  // lazily on the next run.

  var PROTOCOL_VERSION = 1;   // must match pyodide-worker.js
  var seq = 0;

  function createWorkerClient(options) {
    var opts = options || {};
    var WorkerCtor = opts.WorkerCtor || (typeof Worker !== 'undefined' ? Worker : null);
    if (!WorkerCtor) throw new Error('Web Workers are not available');

    var worker = null;
    var current = null;   // { id, resolve }

    function settle() {
      var run = current;
      current = null;
      if (run) run.resolve();
    }

    function onMessage(e) {
      var msg = (e && e.data) || {};

      if (msg.type === 'ready') { if (opts.onReady) opts.onReady(msg); return; }
      if (msg.type === 'stdout') { if (opts.onStdout) opts.onStdout(msg.text); return; }
      if (msg.type === 'stderr') { if (opts.onStderr) opts.onStderr(msg.text); return; }

      // Replies carrying an id belong to a specific run. A reply from a worker
      // we already replaced would otherwise settle the WRONG run.
      if (!current || msg.id !== current.id) return;

      if (msg.type === 'error') {
        if (opts.onError) opts.onError(msg.traceback);
        settle();
        return;
      }
      if (msg.type === 'done') { settle(); return; }
    }

    function ensureWorker() {
      if (worker) return worker;
      worker = new WorkerCtor(opts.workerUrl);
      worker.onmessage = onMessage;
      worker.postMessage({ type: 'init', v: PROTOCOL_VERSION, pyodideUrl: opts.pyodideUrl });
      return worker;
    }

    ensureWorker();

    return {
      run: function(source) {
        var w = ensureWorker();
        var id = 'run-' + (++seq);
        return new Promise(function(resolve) {
          current = { id: id, resolve: resolve };
          w.postMessage({ type: 'run', id: id, source: source });
        });
      },

      // Unconditional. Works for `while True: pass`, which cooperative
      // cancellation can never reach.
      stop: function() {
        if (worker) { worker.terminate(); worker = null; }
        settle();
      },

      isRunning: function() { return !!current; },

      dispose: function() {
        if (worker) { worker.terminate(); worker = null; }
        current = null;
      }
    };
  }

  var api = { createWorkerClient: createWorkerClient, PROTOCOL_VERSION: PROTOCOL_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.workerClient', api);
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/worker-client.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/worker-client.js test/unit/worker-client.test.js
git commit -m "feat(#108): page-side worker client with unconditional stop"
```

---

## Task 4: Wire the runtime into the page

**Files:**
- Modify: `lib/views/embed/pyodide.html` (both `cachify_js` lists)
- Modify: `config/default.yaml` (features block)
- Modify: `public/js/embed/pyodide.js`

**Interfaces:**
- Consumes: `chooseRuntime(source, options)` (Task 1), `createWorkerClient(options)` (Task 3).
- Produces: worker-routed runs actually execute; `window.__trinketRuntime` reports `'main'|'worker'` for tests.

- [ ] **Step 1: Add the config flag**

In `config/default.yaml`, in the `features:` block next to `variableExplorer`, add:

```yaml
  workerRuntime: false  # Run python3 programs in a Web Worker (#108) so the page cannot freeze and Stop always works
```

- [ ] **Step 2: Add the scripts to the page**

In `lib/views/embed/pyodide.html` there are **two** `cachify_js` lists (one for `outputOnly`, one for the normal embed). In **both**, add the two page-side files immediately before `'/js/embed/pyodide.js'`:

```
       '/js/embed/runtime-router.js',
       '/js/embed/worker-client.js',
       '/js/embed/pyodide.js'
```

`pyodide-worker.js` is **not** added — it is loaded by the browser as a worker script, not as a page script.

- [ ] **Step 3: Delegate in the runner**

In `public/js/embed/pyodide.js`, near the other `TrinketIO.import` calls at the top (~line 67), add:

```javascript
var runtimeRouter = TrinketIO.import('embed.runtimeRouter');
var workerClientApi = TrinketIO.import('embed.workerClient');
var workerClient = null;   // created lazily; null means the main-thread path
```

Then in `runCode()`, immediately after `serializedCode` is obtained and before the existing execution begins, insert the routing branch:

```javascript
  // #108: choose a runtime for THIS program. VPython and programs the async
  // transform cannot rewrite stay on the main thread; everything else runs in
  // the worker, where Stop is worker.terminate() and cannot be blocked.
  var decision = runtimeRouter.chooseRuntime(serializedCode, {
    usesVPython   : usesVPython(serializedCode),
    workerEnabled : !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime),
    queryRuntime  : (api._queryString || {}).runtime
  });
  window.__trinketRuntime = decision.runtime;        // read by the browser specs
  window.__trinketRuntimeReason = decision.reason;

  if (decision.runtime === 'worker') {
    return runInWorker(serializedCode);
  }
```

Add `runInWorker()` next to `runCode()`:

```javascript
// #108: run through the worker. Output and tracebacks go through the SAME
// helpers the main-thread path uses, so #107's frame filtering and the console
// escaping apply unchanged.
function runInWorker(source) {
  if (!workerClient) {
    workerClient = workerClientApi.createWorkerClient({
      workerUrl  : '/js/embed/pyodide-worker.js',
      pyodideUrl : PYODIDE_INDEX_URL + 'pyodide.js',   // PYODIDE_INDEX_URL is defined at the top of this file
      onStdout   : function(text) { writeOut(text); },
      onStderr   : function(text) { writeOut(text); },
      onError    : function(traceback) {
        jqconsole.Write('\n' + escapeConsoleHtml(formatPythonTraceback(traceback, mainFile)) + '\n',
                        'jqconsole-error', false);
      }
    });
  }

  $('.stop-it').removeClass('hide');     // same toggle the main-thread path uses
  return workerClient.run(source).then(function() { $('.stop-it').addClass('hide'); });
}
```

**Verified names in `public/js/embed/pyodide.js` — use these exactly:** `PYODIDE_INDEX_URL` (line ~15, ends in a `/`), `mainFile`, `writeOut(text)`, `formatPythonTraceback(msg, mainName)`, `escapeConsoleHtml(text)`, `showGraphic()`, `VARS_HELPER`, `renderVariables(vars)`, `variableExplorerEnabled()`. There are **no** `showStopButton`/`hideStopButton` helpers — the file toggles `$('.stop-it')` directly (see `finishRun`), which is why the snippets above do the same.

- [ ] **Step 4: Route Stop to the worker**

In `stopCode()`, before the existing cooperative-cancellation logic, add:

```javascript
  // A worker-routed run is stopped by terminating the worker — unconditional,
  // and the only thing that can stop `while True: pass`.
  if (workerClient && workerClient.isRunning()) {
    workerClient.stop();
    writeOut('\n[stopped]\n');
    $('.stop-it').addClass('hide');
    return;
  }
```

- [ ] **Step 5: Write the routing spec (this task's own test)**

Create `test/browser/specs/worker-runtime.spec.js` with the two routing tests.
Task 6 extends this same file; do not create a second one.

```javascript
const { test, expect } = require('@playwright/test');

// #108: routing is the contract this task delivers — the right program reaches
// the right runtime. Behaviour of the worker itself is covered in Task 6.
test.describe('Worker runtime (#108)', () => {
  async function editorRun(page, code, query) {
    await page.goto('/embed/python3' + (query || '?runtime=worker'));
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, code);
    await page.locator('.run-it').first().click();
  }

  async function consoleText(page) {
    return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
  }

  test('routes an ordinary program to the worker', async ({ page }) => {
    await editorRun(page, 'print("from the worker")');
    await expect(async () => {
      expect(await consoleText(page)).toContain('from the worker');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
  });

  test('REGRESSION: with the flag off, everything stays on the main thread', async ({ page }) => {
    await editorRun(page, 'print("main")', '/embed/python3');
    await expect(async () => {
      expect(await consoleText(page)).toContain('main');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });
});
```

- [ ] **Step 6: Run it**

```bash
bash scripts/build-info.sh && docker compose -f docker-compose.gcr.yml up -d --build
cd test/browser && npx playwright test specs/worker-runtime.spec.js
```

Expected: 2 passed. A failure here means routing or script loading is wrong — fix before continuing.

- [ ] **Step 7: Rebuild and verify by hand**

```bash
bash scripts/build-info.sh
docker compose -f docker-compose.gcr.yml up -d --build
```

Open `http://localhost:3001/embed/python3?runtime=worker`, run `print("hi")`, and confirm `hi` appears in the console.

- [ ] **Step 8: Run the existing browser specs for regressions**

```bash
cd test/browser && npx playwright test
```

Expected: 44 passed (42 existing + the 2 routing tests). The default is off, so nothing else should change.

- [ ] **Step 9: Commit**

```bash
git add config/default.yaml lib/views/embed/pyodide.html public/js/embed/pyodide.js test/browser/specs/worker-runtime.spec.js
git commit -m "feat(#108): route runs to the worker behind features.workerRuntime"
```

---

## Task 5: `input()` over the channel

**Files:**
- Modify: `public/js/embed/pyodide-worker.js`
- Modify: `public/js/embed/worker-client.js`
- Modify: `public/js/embed/pyodide.js`
- Test: `test/unit/worker-client.test.js` (extend)

**Interfaces:**
- Consumes: `createWorkerClient` (Task 3).
- Produces: worker emits `{ type: 'input-request', id, prompt }`; page replies `{ type: 'stdin-reply', id, value }`. Client gains the `onInputRequest(prompt) → Promise<string>` option.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/worker-client.test.js`:

```javascript
describe('input() over the channel', () => {
  it('asks the page for input and posts the reply back', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    let asked = null;
    const client = createWorkerClient({
      workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker,
      onInputRequest: (prompt) => { asked = prompt; return Promise.resolve('Ada'); }
    });
    client.run('name = input("who? ")');
    const id = made[0].posted.find(m => m.type === 'run').id;

    made[0].onmessage({ data: { type: 'input-request', id, prompt: 'who? ' } });
    await new Promise(r => setTimeout(r, 0));

    expect(asked).toBe('who? ');
    const reply = made[0].posted.find(m => m.type === 'stdin-reply');
    expect(reply).toEqual({ type: 'stdin-reply', id, value: 'Ada' });
  });

  it('does not answer an input request from a stale run', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({
      workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker,
      onInputRequest: () => Promise.resolve('x')
    });
    client.run('input()');
    made[0].onmessage({ data: { type: 'input-request', id: 'stale', prompt: '?' } });
    await new Promise(r => setTimeout(r, 0));
    expect(made[0].posted.find(m => m.type === 'stdin-reply')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/worker-client.test.js`
Expected: FAIL — no `stdin-reply` is posted.

- [ ] **Step 3: Handle the request in the client**

In `public/js/embed/worker-client.js`, inside `onMessage`, after the id check and before the `error` branch:

```javascript
      if (msg.type === 'input-request') {
        // The worker is suspended until we answer. If the page has no handler,
        // answer with an empty string rather than hanging the program forever.
        var answer = opts.onInputRequest
          ? Promise.resolve(opts.onInputRequest(msg.prompt))
          : Promise.resolve('');
        answer.then(function(value) {
          // A stop may have replaced the worker while the student was typing.
          if (worker && current && current.id === msg.id) {
            worker.postMessage({ type: 'stdin-reply', id: msg.id, value: String(value) });
          }
        });
        return;
      }
```

- [ ] **Step 4: Suspend on input in the worker**

In `public/js/embed/pyodide-worker.js`, inside the worker block, add before `run`:

```javascript
    // input() cannot block in a worker: there is no SharedArrayBuffer in an
    // embed (an iframe is only crossOriginIsolated if the TOP page is), so
    // Atomics.wait is unavailable. Instead the transform makes input() awaited,
    // and this promise is resolved by the page's stdin-reply.
    var pendingInput = null;
    self.__trinket_worker_input = function(prompt) {
      post({ type: 'input-request', id: currentRunId, prompt: String(prompt || '') });
      return new Promise(function(resolve) { pendingInput = resolve; });
    };
```

Track `currentRunId` by setting it at the top of `run`:

```javascript
    var currentRunId = null;
    var run = function(msg) {
      currentRunId = msg.id;
      // ...existing body...
    };
```

And handle the reply in `onmessage`, before the unsupported-type fallback:

```javascript
        if (msg.type === 'stdin-reply') {
          if (pendingInput) { var r = pendingInput; pendingInput = null; r(msg.value); }
          return;
        }
```

- [ ] **Step 5: Point Python's `input()` at it**

Still in the worker, extend `boot()` so the namespace has an awaitable `input`, injected after Pyodide loads:

```javascript
        pyodide.runPython([
          'import builtins, js',
          'async def _trinket_input(prompt=""):',
          '    return await js.__trinket_worker_input(prompt)',
          'builtins.input = _trinket_input'
        ].join('\n'));
```

- [ ] **Step 6: Prompt the student from the page**

In `runInWorker()` in `public/js/embed/pyodide.js`, add to the client options:

```javascript
      onInputRequest : function(prompt) {
        // Same widget console.input() already uses, so the REPL and a running
        // program prompt identically.
        return new Promise(function(resolve) {
          if (prompt) { writeOut(String(prompt)); }
          jqconsole.Input(function(line) { resolve(line); });
        });
      },
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/worker-client.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 8: Verify by hand**

Rebuild, open `http://localhost:3001/embed/python3?runtime=worker`, run:

```python
name = input("who? ")
print("hello", name)
```

Expected: the prompt appears, typing a name and pressing Enter prints `hello <name>`.

- [ ] **Step 9: Commit**

```bash
git add public/js/embed/pyodide-worker.js public/js/embed/worker-client.js public/js/embed/pyodide.js test/unit/worker-client.test.js
git commit -m "feat(#108): async input() over the worker channel, no SharedArrayBuffer"
```

---

## Task 6: Browser specs — the behaviour that matters

**Files:**
- Modify: `test/browser/specs/worker-runtime.spec.js` (created in Task 4)

**Interfaces:**
- Consumes: `window.__trinketRuntime` (Task 4), the worker path (Tasks 2–5).
- Produces: the regression net for this project.

- [ ] **Step 1: Extend the spec**

`test/browser/specs/worker-runtime.spec.js` already exists from Task 4 with the two
routing tests and the `editorRun` / `consoleText` helpers. **Add the tests below to
that same `describe` block** — do not redefine the helpers and do not create a second
file. The routing test and the flag-off regression test are already there; the full
file after this task is:

```javascript
const { test, expect } = require('@playwright/test');

// #108: the claims that only a real browser can settle — that the page stays
// responsive during a runaway loop, and that Stop kills it. A unit test cannot
// prove either, because both are about the UI thread.
test.describe('Worker runtime (#108)', () => {
  async function editorRun(page, code) {
    await page.goto('/embed/python3?runtime=worker');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, code);
    await page.locator('.run-it').first().click();
  }

  async function consoleText(page) {
    return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
  }

  test('routes an ordinary program to the worker', async ({ page }) => {
    await editorRun(page, 'print("from the worker")');
    await expect(async () => {
      expect(await consoleText(page)).toContain('from the worker');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
  });

  test('keeps VPython on the main thread', async ({ page }) => {
    await editorRun(page, 'from vpython import *\nsphere()');
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
    }).toPass({ timeout: 90_000 });
  });

  test('THE POINT: the page stays responsive during `while True: pass`', async ({ page }) => {
    await editorRun(page, 'while True:\n    pass');
    // If the UI thread were blocked this evaluate() would never resolve.
    await page.waitForTimeout(3000);
    const alive = await page.evaluate(() => { document.title = 'alive'; return document.title; });
    expect(alive).toBe('alive');
  });

  test('THE POINT: Stop kills `while True: pass`', async ({ page }) => {
    await editorRun(page, 'while True:\n    pass');
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 90_000 });
    await page.locator('.stop-it').first().click();

    await expect(async () => {
      expect(await consoleText(page)).toContain('[stopped]');
    }).toPass({ timeout: 30_000 });
    await expect(page.locator('.stop-it')).toBeHidden();
  });

  test('a program still runs after a stop (replacement worker)', async ({ page }) => {
    await editorRun(page, 'while True:\n    pass');
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 90_000 });
    await page.locator('.stop-it').first().click();

    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue('print("second run")', 1);
    });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      expect(await consoleText(page)).toContain('second run');
    }).toPass({ timeout: 90_000 });
  });

  test('input() prompts and resumes', async ({ page }) => {
    await editorRun(page, 'name = input("who? ")\nprint("hello", name)');
    await expect(async () => {
      expect(await consoleText(page)).toContain('who?');
    }).toPass({ timeout: 90_000 });

    await page.locator('#console-output').click();
    await page.keyboard.type('Ada');
    await page.keyboard.press('Enter');

    await expect(async () => {
      expect(await consoleText(page)).toContain('hello Ada');
    }).toPass({ timeout: 30_000 });
  });

  test('a traceback from the worker is filtered like the main thread (#107)', async ({ page }) => {
    await editorRun(page, 'print(int("hi"))');
    await expect(async () => {
      const text = await consoleText(page);
      expect(text).toContain('ValueError');
      expect(text).not.toMatch(/_pyodide|python\d*\.zip|_base\.py|CodeRunner/);
    }).toPass({ timeout: 90_000 });
  });

  test('REGRESSION: with the flag off, everything stays on the main thread', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue('print("main")', 1);
    });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      expect(await consoleText(page)).toContain('main');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });
});
```

- [ ] **Step 2: Rebuild and run the spec**

```bash
bash scripts/build-info.sh
docker compose -f docker-compose.gcr.yml up -d --build
cd test/browser && npx playwright test specs/worker-runtime.spec.js
```

Expected: 8 passed. If the traceback test fails on frames unique to the worker, extend `TRACEBACK_INTERNAL` in `public/js/embed/pyodide.js` and **add a test for each pattern added** — do not loosen the regex without a test.

- [ ] **Step 3: Run the full browser suite**

```bash
cd test/browser && npx playwright test
```

Expected: 50 passed (42 existing + 8 new). Note: `specs/input.spec.js` has an observed intermittent failure — if it fails, re-run that file alone to confirm before treating it as a regression.

- [ ] **Step 4: Commit**

```bash
git add test/browser/specs/worker-runtime.spec.js
git commit -m "test(#108): browser specs for worker routing, stop, input and tracebacks"
```

---

## Task 7: matplotlib over the channel

**Files:**
- Modify: `public/js/embed/pyodide-worker.js`
- Modify: `public/js/embed/pyodide.js`
- Modify: `test/browser/specs/worker-runtime.spec.js`

**Interfaces:**
- Consumes: the channel from Tasks 2–3.
- Produces: worker emits `{ type: 'figure', id, figureId, kind: 'png', data }`; the page renders it into `#graphic`.

**Scope note:** this task ships the **PNG payload only**. Interactive `backend_webagg_core` + `mpl.js` is the follow-up described in the spec; it reuses this exact message with `kind: 'diff'`, so nothing here is throwaway.

- [ ] **Step 1: Write the failing test**

Add to `test/browser/specs/worker-runtime.spec.js`:

```javascript
  test('a matplotlib figure from the worker is displayed', async ({ page }) => {
    await editorRun(page, [
      'import matplotlib.pyplot as plt',
      'plt.plot([1, 2, 3], [2, 4, 9])',
      'plt.show()'
    ].join('\n'));

    await expect(page.locator('#graphic img.worker-figure')).toBeVisible({ timeout: 180_000 });
    const src = await page.locator('#graphic img.worker-figure').getAttribute('src');
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd test/browser && npx playwright test specs/worker-runtime.spec.js -g "matplotlib figure"
```

Expected: FAIL — no `img.worker-figure` appears.

- [ ] **Step 3: Emit figures from the worker**

In `public/js/embed/pyodide-worker.js`, extend `boot()` after the `input` injection:

```javascript
        // Agg is headless — the webagg/html5 backends both need `document`,
        // which a worker does not have. plt.show() ships each figure to the
        // page as a PNG. The spec's follow-up swaps this payload for
        // backend_webagg_core diffs using the SAME message.
        self.__trinket_worker_figure = function(b64) {
          post({ type: 'figure', id: currentRunId, figureId: 'fig', kind: 'png', data: b64 });
        };
```

and inject the Python side lazily, only when matplotlib is imported, inside `run` before execution:

```javascript
      if (/(^|\n)\s*(import|from)\s+[^\n]*matplotlib/.test(msg.source)) {
        pyodide.runPython([
          'import matplotlib',
          "matplotlib.use('Agg')",
          'import matplotlib.pyplot as plt, io, base64, js',
          'def _trinket_show(*a, **k):',
          '    for num in plt.get_fignums():',
          '        buf = io.BytesIO()',
          '        plt.figure(num).savefig(buf, format="png")',
          '        js.__trinket_worker_figure(base64.b64encode(buf.getvalue()).decode())',
          '    plt.close("all")',
          'plt.show = _trinket_show'
        ].join('\n'));
      }
```

- [ ] **Step 4: Render figures on the page**

In `runInWorker()` in `public/js/embed/pyodide.js`, add to the client options:

```javascript
      onFigure : function(msg) {
        var wrap = document.getElementById('graphic');
        if (!wrap) return;
        var img = document.createElement('img');
        img.className = 'worker-figure';
        img.style.maxWidth = '100%';
        img.src = 'data:image/png;base64,' + msg.data;
        wrap.appendChild(img);
        showGraphic();     // splits the pane, exactly as the main-thread path does
      },
```

and in `public/js/embed/worker-client.js`, inside `onMessage` next to the other typed branches:

```javascript
      if (msg.type === 'figure') { if (opts.onFigure) opts.onFigure(msg); return; }
```

Place this branch **before** the id check, because a figure is not a run-completion signal and the page should render it regardless.

- [ ] **Step 5: Run the test to verify it passes**

```bash
bash scripts/build-info.sh && docker compose -f docker-compose.gcr.yml up -d --build
cd test/browser && npx playwright test specs/worker-runtime.spec.js
```

Expected: 9 passed. The matplotlib test may take up to 3 minutes on a cold Pyodide package download.

- [ ] **Step 6: Commit**

```bash
git add public/js/embed/pyodide-worker.js public/js/embed/worker-client.js public/js/embed/pyodide.js test/browser/specs/worker-runtime.spec.js
git commit -m "feat(#108): render matplotlib figures from the worker as PNG"
```

---

## Task 8: Variable explorer over the channel

**Files:**
- Modify: `public/js/embed/pyodide-worker.js`
- Modify: `public/js/embed/worker-client.js`
- Modify: `public/js/embed/pyodide.js`
- Test: `test/unit/worker-client.test.js` (extend)

**Interfaces:**
- Consumes: the channel from Tasks 2–3.
- Produces: client gains `snapshot() → Promise<Array>`; worker answers `snapshot` with `snapshot-result`.

**Why this works** (from the spec, D6): `VARS_HELPER` already ends in `json.dumps(...)` and the page already does a single `JSON.parse`, so nothing live crosses the boundary. It is read only **post-run**, when the worker is idle and can answer.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/worker-client.test.js`:

```javascript
describe('variable snapshot over the channel', () => {
  it('requests a snapshot and resolves with the parsed array', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });

    const p = client.snapshot();
    const req = made[0].posted.find(m => m.type === 'snapshot');
    expect(req).toBeTruthy();

    made[0].onmessage({ data: { type: 'snapshot-result', id: req.id, json: '[{"name":"x","value":"42"}]' } });
    await expect(p).resolves.toEqual([{ name: 'x', value: '42' }]);
  });

  it('resolves to an empty array when the worker reports a failure', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    const p = client.snapshot();
    const req = made[0].posted.find(m => m.type === 'snapshot');
    made[0].onmessage({ data: { type: 'snapshot-result', id: req.id, json: null } });
    await expect(p).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/worker-client.test.js`
Expected: FAIL — `client.snapshot is not a function`.

- [ ] **Step 3: Add `snapshot()` to the client**

In `public/js/embed/worker-client.js`, add a pending-request map above `createWorkerClient`'s return, and the branch in `onMessage`:

```javascript
    var pending = {};   // id -> resolve, for request/response messages

    // ...inside onMessage, before the current-run id check:
      if (msg.type === 'snapshot-result') {
        var done = pending[msg.id];
        if (done) {
          delete pending[msg.id];
          var parsed = [];
          try { parsed = msg.json ? JSON.parse(msg.json) : []; } catch (e) { parsed = []; }
          done(parsed);
        }
        return;
      }
```

and the method on the returned object:

```javascript
      // Post-run only: the worker is idle then, so it can answer. Nothing live
      // crosses the channel — VARS_HELPER already produces JSON.
      snapshot: function() {
        var w = ensureWorker();
        var id = 'snap-' + (++seq);
        return new Promise(function(resolve) {
          pending[id] = resolve;
          w.postMessage({ type: 'snapshot', id: id });
        });
      },
```

- [ ] **Step 4: Answer it in the worker**

In `public/js/embed/pyodide-worker.js`, add a `snapshot` branch in `onmessage` before the unsupported-type fallback:

```javascript
        if (msg.type === 'snapshot') {
          var json = null;
          try {
            var ns = pyodide.toPy({ user_ns: pyodide.globals });
            json = pyodide.runPython(self.__trinket_vars_helper, { globals: ns });
            if (ns && ns.destroy) ns.destroy();
          } catch (e) { json = null; }
          post({ type: 'snapshot-result', id: msg.id, json: json });
          return;
        }
```

`self.__trinket_vars_helper` is set by the page in the `init` message so the helper source stays in **one** place:

- in `pyodide-worker.js` `boot()`: `self.__trinket_vars_helper = msg.varsHelper || '';`
- in `worker-client.js` `ensureWorker()`: add `varsHelper: opts.varsHelper` to the `init` payload.
- in `pyodide.js` `runInWorker()`: pass `varsHelper: VARS_HELPER` (the existing constant).

- [ ] **Step 5: Use it after a worker run**

In `runInWorker()`, change the completion handler:

```javascript
  return workerClient.run(source).then(function() {
    $('.stop-it').addClass('hide');
    if (variableExplorerEnabled()) {
      workerClient.snapshot().then(function(vars) { renderVariables(vars); });
    }
  });
```

And in `stopCode()`'s worker branch, after `writeOut('\n[stopped]\n')`, add:

```javascript
    // Terminating discards the namespace, so there is no post-run snapshot to
    // take. Say so rather than leaving a stale or blank table (spec §8a).
    if (variableExplorerEnabled()) {
      renderVariables([]);
      $('#debug-note').text('variables unavailable — the program was stopped');
    }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/worker-client.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 7: Verify by hand**

Set `variableExplorer: true` in `config/default.yaml` **temporarily**, rebuild, run `x = 42` at `?runtime=worker`, and confirm the Variables tab shows `x`. Then **revert the flag to `false`** before committing.

- [ ] **Step 8: Commit**

```bash
git add public/js/embed/pyodide-worker.js public/js/embed/worker-client.js public/js/embed/pyodide.js test/unit/worker-client.test.js
git commit -m "feat(#108): variable explorer snapshots over the worker channel"
```

---

## Task 9: The REPL in the worker

**Files:**
- Modify: `public/js/embed/pyodide-worker.js`
- Modify: `public/js/embed/worker-client.js`
- Modify: `public/js/embed/pyodide.js`
- Modify: `test/browser/specs/repl.spec.js`

**Interfaces:**
- Consumes: `createWorkerClient` (Task 3).
- Produces: `run` gains an optional `mode: 'repl'` field (not a new message type — the
  protocol list in Global Constraints is closed). Client gains `pushRepl(source) → Promise`.

**Why:** the REPL's one documented limitation today is that an infinite loop typed at
the prompt freezes the tab with no recovery but reload. In the worker, Stop terminates it.
The cost is stated in spec §7 and must be surfaced to the student: terminating **loses the
session's variables**.

- [ ] **Step 1: Write the failing test**

Add to `test/browser/specs/repl.spec.js`, inside the existing `describe`:

```javascript
  test('a runaway REPL statement can be stopped, and says the session reset', async ({ page }) => {
    // Today this freezes the tab with no recovery but reload — the REPL's one
    // documented limitation. In the worker, Stop terminates it.
    await page.goto('/embed/python3?runMode=console&start=result&runtime=worker');
    await replPrompt(page);

    await typeLine(page, 'x = 41');
    await typeLine(page, 'while True: pass');

    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 90_000 });
    await page.locator('.stop-it').first().click();

    await expect(async () => {
      const text = await consoleText(page);
      expect(text).toContain('console session reset');
    }).toPass({ timeout: 30_000 });

    // The prompt is usable again, on a FRESH namespace.
    await typeLine(page, 'x');
    await expect(async () => {
      expect(await consoleText(page)).toMatch(/NameError/);
    }).toPass({ timeout: 90_000 });
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd test/browser && npx playwright test specs/repl.spec.js -g "runaway REPL"
```

Expected: FAIL — the tab freezes and the test times out, which is the bug.

- [ ] **Step 3: Hold a console in the worker**

In `public/js/embed/pyodide-worker.js`, add inside the worker block:

```javascript
    // A PyodideConsole living in the WORKER, so the REPL namespace persists
    // between statements exactly as it does on the main thread.
    var replConsole = null;
    function ensureReplConsole() {
      if (!replConsole) {
        replConsole = pyodide.runPython(
          'from pyodide.console import PyodideConsole\n' +
          'PyodideConsole(globals())\n'
        );
      }
      return replConsole;
    }

    function pushRepl(msg) {
      var console_ = ensureReplConsole();
      return Promise.resolve(console_.push(msg.source))
        .then(function(value) {
          if (value !== undefined && value !== null) {
            post({ type: 'stdout', text: pyodide.runPython('repr')(value) + '\n' });
          }
          post({ type: 'done', id: msg.id });
        })
        .catch(function(err) {
          post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
        });
    }
```

and branch on the mode inside the existing `run` handler in `onmessage`:

```javascript
        if (msg.type === 'run') {
          if (msg.mode === 'repl') { pushRepl(msg); } else { run(msg); }
          return;
        }
```

- [ ] **Step 4: Add `pushRepl()` to the client**

In `public/js/embed/worker-client.js`, on the returned object:

```javascript
      // Same channel and same correlation as run(); only the mode differs, so
      // stop() and the id-matching logic apply unchanged.
      pushRepl: function(source) {
        var w = ensureWorker();
        var id = 'repl-' + (++seq);
        return new Promise(function(resolve) {
          current = { id: id, resolve: resolve };
          w.postMessage({ type: 'run', id: id, mode: 'repl', source: source });
        });
      },
```

- [ ] **Step 5: Use it from the REPL, and say so when the session is lost**

In `public/js/embed/pyodide.js`, in `startReplPrompt()`, replace the direct
`console_.push(input)` call with a worker-routed one **when the REPL is running in
the worker**. Keep the main-thread path untouched:

```javascript
    if (replUsesWorker()) {
      $('.stop-it').removeClass('hide');
      workerClient.pushRepl(input).then(function() {
        $('.stop-it').addClass('hide');
        startReplPrompt();
      });
      return;
    }
```

Add the predicate next to `startRepl()`:

```javascript
// The REPL runs in the worker only when this trinket is worker-routed at all.
// A REPL statement has no source to inspect up front, so the decision is made
// once, from config and the query string, not per statement.
function replUsesWorker() {
  var decision = runtimeRouter.chooseRuntime('', {
    usesVPython   : false,
    workerEnabled : !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime),
    queryRuntime  : (api._queryString || {}).runtime
  });
  return decision.runtime === 'worker' && !!workerClient;
}
```

In `stopCode()`'s worker branch, extend the message when a REPL is active:

```javascript
    // Terminating discards the interpreter, so the REPL's variables are gone.
    // Say so plainly rather than letting a student wonder why `x` vanished.
    if (replActive) {
      writeOut('\n[stopped — console session reset]\n');
      startReplPrompt();
    } else {
      writeOut('\n[stopped]\n');
    }
```

Ensure `runInWorker()` has created `workerClient` before the REPL starts: in
`startRepl()`, when `replUsesWorker()` would be true, call the same lazy
constructor `runInWorker()` uses. Extract that construction into a
`ensureWorkerClient()` helper and call it from both, rather than duplicating the
options object.

- [ ] **Step 6: Run the REPL specs**

```bash
bash scripts/build-info.sh && docker compose -f docker-compose.gcr.yml up -d --build
cd test/browser && npx playwright test specs/repl.spec.js
```

Expected: 16 passed (15 existing + 1 new).

- [ ] **Step 7: Commit**

```bash
git add public/js/embed/pyodide-worker.js public/js/embed/worker-client.js public/js/embed/pyodide.js test/browser/specs/repl.spec.js
git commit -m "feat(#108): run the REPL in the worker so a runaway statement is stoppable"
```

---

## Task 10: Documentation and rollout

**Files:**
- Modify: `docs/DEPLOY-OVERLAY-GUIDE.md`
- Modify: `config/default.yaml` (comment only)

**Interfaces:**
- Consumes: everything above.
- Produces: the flag is documented; no behaviour change.

- [ ] **Step 1: Document the flag**

Add to `docs/DEPLOY-OVERLAY-GUIDE.md`, in the features section:

```markdown
### `features.workerRuntime` (default `false`)

Runs python3 programs in a Web Worker (#108) so the page cannot freeze and Stop
always works — including for `while True: pass`, which cooperative cancellation
can never interrupt.

Programs that stay on the main thread regardless of this flag:

- **VPython / Web VPython** — its bridge binds `from js import sphere, box, rate, …`
  to the window realm, which does not exist in a worker.
- Programs calling `input()`, `sleep()` or `rate()` inside a **lambda or
  comprehension**, where the async transform cannot insert `await`.

Per-trinket escape hatch: `?runtime=main` forces the main thread, `?runtime=worker`
forces the worker even when this flag is off.

**Known limitation:** stopping a worker-routed program terminates it, so the
Variables panel has no post-run snapshot to show and reports
"variables unavailable — the program was stopped". This is the price of a Stop
that always works.
```

- [ ] **Step 2: Verify the docs build is unaffected**

Run: `npm test`
Expected: no new failures (documentation only).

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY-OVERLAY-GUIDE.md config/default.yaml
git commit -m "docs(#108): document features.workerRuntime and its routing rules"
```

- [ ] **Step 4: Final full verification**

```bash
npm test
bash scripts/build-info.sh && docker compose -f docker-compose.gcr.yml up -d --build
cd test/browser && npx playwright test
```

Expected: unit suite green; browser suite 52 passed (42 existing + 9 worker specs + 1 REPL spec).

---

## After the plan

Rollout is deliberately **not** a task, because it needs Steve:

1. Merge #114/#117/#122 upstream first, resolving the duplicate `escapeConsoleHtml` to a single definition.
2. Deploy to the trials with `workerRuntime: true` and work the manual smoke checklist.
3. Flip the default only once the trials are clean.

**Deferred to their own specs** (do not attempt here):

- `backend_webagg_core` + `mpl.js` for interactive figures — reuses the `figure` message with `kind: 'diff'`.
- The step debugger's `record`/`expand` messages — same shape as Task 8's `snapshot`.
- The VPython proxy bridge, which is what makes interactive 3D work in the worker. The `scene-ops` / `scene-event` message types are already reserved for it.
