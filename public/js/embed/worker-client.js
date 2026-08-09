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
    var current = null;   // { id, resolve } for the in-flight run

    function settle() {
      var run = current;
      current = null;
      if (run) run.resolve();
    }

    function onMessage(e) {
      var msg = (e && e.data) || {};

      // Lifecycle and streaming messages are not tied to a specific run.
      if (msg.type === 'ready')  { if (opts.onReady)  opts.onReady(msg);       return; }
      if (msg.type === 'stdout') { if (opts.onStdout) opts.onStdout(msg.text); return; }
      if (msg.type === 'stderr') { if (opts.onStderr) opts.onStderr(msg.text); return; }

      // Everything below completes a run. A reply from a worker we already
      // replaced carries a stale id and must NOT settle the current run —
      // otherwise stopping and immediately re-running would end the new run the
      // moment the dead worker's last message arrived.
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
      worker.postMessage({
        type: 'init',
        v: PROTOCOL_VERSION,
        pyodideUrl: opts.pyodideUrl,
        indexURL: opts.indexURL
      });
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
