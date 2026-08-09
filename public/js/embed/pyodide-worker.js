(function(root) {
  'use strict';

  // #108: the Pyodide kernel, off the main thread.
  //
  // This file must NEVER reference `document`, `window`, or GlowScript — it has
  // `self` only. Anything visual crosses the channel as a message and is
  // rendered by the page.
  //
  // Stop is not implemented here, deliberately. The page calls
  // worker.terminate(), which is unconditional and therefore works for
  // `while True: pass` — the case cooperative cancellation can never reach,
  // because a loop with no yield point never lets the page run at all.
  //
  // Tracebacks are sent RAW. The page owns formatPythonTraceback() and
  // escapeConsoleHtml(); formatting here would let the two runtimes drift.

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
    var currentRunId = null;

    var post = function(msg) { self.postMessage(msg); };

    var boot = function(msg) {
      self.importScripts(msg.pyodideUrl);
      return self.loadPyodide({ indexURL: msg.indexURL }).then(function(py) {
        pyodide = py;
        // Batched, exactly as the in-window runner does, so partial lines are
        // not emitted one character at a time.
        pyodide.setStdout({ batched: function(s) { post({ type: 'stdout', text: s + '\n' }); } });
        pyodide.setStderr({ batched: function(s) { post({ type: 'stderr', text: s + '\n' }); } });
        post({ type: 'ready', v: PROTOCOL_VERSION, pyodideVersion: pyodide.version });
      }).catch(function(err) {
        post({ type: 'error', id: null, traceback: 'Failed to start Python: ' + String(err && err.message || err) });
      });
    };

    // ---- input() without SharedArrayBuffer ---------------------------------
    //
    // An embed can never be crossOriginIsolated (an iframe is only isolated if
    // the TOP page is), so Atomics.wait is unavailable and input() cannot block.
    // Instead it becomes awaitable: the page answers `input-request` with
    // `stdin-reply`, and this promise resolves.
    var pendingInput = null;

    self.__trinket_worker_input = function(prompt) {
      post({ type: 'input-request', id: currentRunId, prompt: String(prompt || '') });
      return new Promise(function(resolve) { pendingInput = resolve; });
    };

    // The prompt is NOT printed from Python. Pyodide's batched stdout only
    // flushes on a newline, and a prompt has none — so `print(prompt, end="")`
    // stayed buffered and appeared AFTER the student's answer. The page writes
    // it instead, from the prompt text carried on the input-request message.
    var INPUT_SETUP = [
      'import builtins, js',
      'async def _trinket_input(prompt=""):',
      '    return await js.__trinket_worker_input(prompt)',
      'builtins.input = _trinket_input'
    ].join('\n');

    // The async transform rewrites blocking-looking calls to `await`. Its await
    // set is a module constant that deliberately EXCLUDES bare `input`, because
    // on the main thread input() is synchronous (window.prompt). Here it must be
    // awaited, so the set is extended — safe because this is the worker's own
    // interpreter and cannot affect the page's.
    var transformLoading = null;
    function ensureTransform(url) {
      if (transformLoading) return transformLoading;
      transformLoading = fetch(url)
        .then(function(r) { return r.text(); })
        .then(function(src) {
          pyodide.FS.writeFile('_trinket_async_transform.py', src);
          return pyodide.runPythonAsync([
            'import _trinket_async_transform as _t',
            '_t._BASE_AWAIT_NAMES = _t._BASE_AWAIT_NAMES | {"input"}',
            'from _trinket_async_transform import transform_source'
          ].join('\n'));
        })
        .catch(function(e) {
          // Never cache a failed load, or one transient fetch error poisons
          // every later run for the life of this worker.
          transformLoading = null;
          throw e;
        });
      return transformLoading;
    }

    // Only programs that actually read input need rewriting; everything else
    // runs unmodified, so the transform can't perturb an ordinary program.
    function needsTransform(src) {
      return /(^|[^.\w])input\s*\(/.test(src || '') || /\bconsole\s*\.\s*input\s*\(/.test(src || '');
    }

    var run = function(msg) {
      currentRunId = msg.id;

      // Secondary .py modules must exist in the worker's own filesystem before
      // the program imports them — the same job syncFilesToFS() does on the
      // main thread. The main file is passed as `source` and is not written.
      if (msg.files) {
        for (var name in msg.files) {
          if (!Object.prototype.hasOwnProperty.call(msg.files, name)) continue;
          if (!/\.py$/.test(name)) continue;
          try { pyodide.FS.writeFile(name, msg.files[name]); } catch (e) {}
        }
      }

      var source = msg.source || '';
      var prepared = needsTransform(source)
        ? ensureTransform(msg.transformUrl).then(function() {
            pyodide.globals.set('__user_source__', source);
            return pyodide.runPythonAsync(INPUT_SETUP).then(function() {
              return pyodide.runPython('transform_source(__user_source__)');
            });
          })
        : Promise.resolve(source);

      return prepared
        .then(function(src) { return pyodide.runPythonAsync(src); })
        .then(function() { post(buildRunReply(msg.id, { ok: true })); })
        .catch(function(err) {
          post(buildRunReply(msg.id, { ok: false, traceback: String(err && err.message || err) }));
        });
    };

    self.onmessage = function(e) {
      var msg = e.data || {};
      try {
        if (msg.type === 'init') { boot(msg); return; }

        if (msg.type === 'stdin-reply') {
          if (pendingInput) {
            var resolve = pendingInput;
            pendingInput = null;
            resolve(msg.value);
          }
          return;
        }

        if (msg.type === 'run') {
          if (!pyodide) {
            post({ type: 'error', id: msg.id, traceback: 'Python is not ready yet.' });
            return;
          }
          run(msg);
          return;
        }

        // Reserved types are DEFINED by the spec but not implemented in v1.
        // Answer explicitly rather than dropping the message silently, so a
        // caller gets a diagnosable error instead of a hang.
        post({
          type: 'error',
          id: msg.id,
          traceback: 'message type not supported in runtime v' + PROTOCOL_VERSION + ': ' + msg.type
        });
      } catch (err) {
        post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
      }
    };
  }

  var api = { buildRunReply: buildRunReply, PROTOCOL_VERSION: PROTOCOL_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
