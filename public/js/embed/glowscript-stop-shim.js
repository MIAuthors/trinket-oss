// Runner-side half of the GlowScript Stop button.
//
// install() runs INSIDE a program's sandboxed runner page: glowscript.js
// injects source() into the runner template, ahead of the program. So install
// must stay self-contained -- it may use nothing but its parameter and the
// runner's own globals.
//
// While no stop is requested every wrapped wait is a pass-through. After a stop
// request a wait in progress never hands control back to the program and a new
// wait never starts, so the program parks where it is and the scene stays live
// (camera rotation and zoom belong to the runtime, not the program). The runner
// confirms with glowscript.stopped once the program is parked.
//
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md
// UMD-lite: window global for the embed page, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketGlowscriptStopShim = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function install(win) {
    'use strict';
    if (win.__trinketStop) { return win.__trinketStop; }

    var stop = { requested: false, pending: 0, confirmed: false };
    win.__trinketStop = stop;

    function post(message) {
      try { win.parent.postMessage(JSON.stringify(message), '*'); } catch (e) {}
    }

    function confirm() {
      if (stop.confirmed) { return; }
      stop.confirmed = true;
      post({ 'glowscript.stopped': true });
    }

    function parkForever() {
      return new Promise(function () {});
    }

    function wrap(owner, name) {
      var original = owner && owner[name];
      if (typeof original !== 'function' || original.__trinketStoppable) { return; }

      var wrapped = function () {
        if (stop.requested) {
          confirm();
          return parkForever();
        }

        var args = Array.prototype.slice.call(arguments);
        var last = args.length - 1;

        // GlowScript 1.1 to 2.7 pass the program's continuation last.
        if (last >= 0 && typeof args[last] === 'function') {
          var resume = args[last];
          stop.pending += 1;
          args[last] = function () {
            stop.pending -= 1;
            if (stop.requested) { confirm(); return undefined; }
            return resume.apply(this, arguments);
          };
          return original.apply(this, args);
        }

        // GlowScript 2.9 and later: the program awaits the result.
        var result = original.apply(this, args);
        if (!result || typeof result.then !== 'function') { return result; }
        stop.pending += 1;
        return new Promise(function (resolve, reject) {
          result.then(function (value) {
            stop.pending -= 1;
            if (stop.requested) { confirm(); return; }
            resolve(value);
          }, function (error) {
            stop.pending -= 1;
            if (stop.requested) { confirm(); return; }
            reject(error);
          });
        });
      };

      wrapped.__trinketStoppable = true;
      owner[name] = wrapped;
    }

    ['rate', 'sleep', 'waitfor', 'pause'].forEach(function (name) { wrap(win, name); });
    if (typeof win.canvas === 'function' && win.canvas.prototype) {
      wrap(win.canvas.prototype, 'waitfor');
      wrap(win.canvas.prototype, 'pause');
    }

    win.addEventListener('message', function (event) {
      if (event.data !== 'glowscript.stop' || stop.requested) { return; }
      stop.requested = true;
      if (stop.pending > 0) { confirm(); }
    });

    post({ 'glowscript.ready': true });
    return stop;
  }

  // The statement glowscript.js puts into the runner template.
  function source() {
    return '(' + install.toString() + ')(window);';
  }

  return { install: install, source: source };
}));
