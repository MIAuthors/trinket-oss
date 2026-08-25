// Retry policy for the glowscript runner's runtime files (picup #-tbd).
//
// Under a cold-start thundering herd (1000 students opening an exam embed,
// measured 2026-08-24) Cloud Run sheds a slice of requests for the LARGEST
// runtime file while it scales — 172/1000 students lost glow.min.js and got a
// blank scene. In a lockdown browser (Safe Exam Browser, Respondus) there is
// no refresh available to the student, so the page must recover by itself.
//
// The recovery is a full runner rebuild: every srcdoc resource is no-store, a
// rebuild refetches them all, and by the first backoff the fleet is warmer.
// This module only DECIDES; the page owns the DOM and the clock.
//
// UMD-lite: window global for the embed page, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketRunnerRetry = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Ours to fix by rebuilding: the files the runner cannot work without.
  // Stylesheets are cosmetic and MathJax is third-party — a rebuild for those
  // would interrupt a working scene for nothing.
  var RUNTIME_RE = /\/package\/(glow|RSrun|RScompiler)\.|\/lib\/jquery\//;

  function isRuntimeFile(src) {
    return RUNTIME_RE.test(String(src || ''));
  }

  // One policy per page; delaysMs both paces the rebuilds and caps them.
  function create(opts) {
    opts = opts || {};
    var delays   = opts.delaysMs || [1000, 3000, 7000];
    var attempts = 0;
    var pending  = false;

    return {
      // A srcdoc resource failed to load. Returns
      //   { retry: true,  delayMs }   — rebuild after delayMs
      //   { retry: false, reason }    — 'not-runtime' | 'pending' | 'exhausted'
      // 'pending' collapses the burst: when an instance is shedding, several
      // sibling script tags typically fail together, and one rebuild serves
      // them all.
      onLoadFailure: function (src) {
        if (!isRuntimeFile(src)) { return { retry: false, reason: 'not-runtime' }; }
        if (pending)             { return { retry: false, reason: 'pending' }; }
        if (attempts >= delays.length) { return { retry: false, reason: 'exhausted' }; }
        pending = true;
        return { retry: true, delayMs: delays[attempts++] };
      },
      // The page is about to rebuild: accept failure reports again.
      rebuilding: function () { pending = false; },
      // A fresh user-initiated Run starts a fresh budget.
      reset: function () { attempts = 0; pending = false; }
    };
  }

  return { create: create, isRuntimeFile: isRuntimeFile };
}));
