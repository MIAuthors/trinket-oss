'use strict';

// Content-Security-Policy for /embed/* responses.
//
// Test mode (runMode=calculator) is meant to be a self-contained environment:
// what the student sees is what the trinket contains. This applies a policy so
// an embedded program cannot pull in outside content — no third-party images,
// media, frames, or network — which is what "calculator mode" implies to an
// instructor setting an exam.
//
// Normal embeds keep remote images and media, because existing course material
// legitimately uses remote textures. Frames are disallowed in both modes: no
// program has a reason to embed one, and a mis-set run mode should not change
// that.
//
// Mechanism notes for maintainers:
//   * glowscript runs the program in a `srcdoc` iframe; such a document
//     inherits the embedding page's policy, so setting it here reaches the
//     program. The program cannot alter it (its frame has an opaque origin).
//   * The policy also governs fetch() from a Web Worker created via a blob:
//     URL — the shape the pyodide worker runtime uses — because such a worker
//     inherits its creator's policy. Verified in Chrome, 2026-08-19.
//   * `sandbox` on the frame does not overlap with this: it constrains what the
//     program may do, not which URLs may be loaded.
//
// runMode=calculator is trinket's exam/test mode — it already suppresses
// sharing and copying, so it is the natural signal for "no third-party
// content".
var EXAM_RUN_MODE = 'calculator';

function isEmbedPath(pathname) {
  return typeof pathname === 'string' && pathname.indexOf('/embed/') === 0;
}

/**
 * @param {object} cspConfig  config.app.csp
 * @param {string} pathname   request path
 * @param {string} runMode    the runMode query parameter
 * @returns {string|null} the policy, or null when none applies
 */
function policyFor(cspConfig, pathname, runMode) {
  if (!cspConfig || !cspConfig.enabled) return null;
  if (!isEmbedPath(pathname)) return null;

  var policy = (runMode === EXAM_RUN_MODE) ? cspConfig.exam : cspConfig.standard;
  if (!policy) return null;

  var cdn = (cspConfig.cdnOrigins || []).join(' ');
  return policy
    .replace(/\{cdn\}/g, cdn)
    .replace(/\s+/g, ' ')       // the YAML block folds across lines
    .replace(/\s+;/g, ';')      // empty {cdn} would otherwise leave "'self' ;"
    .trim();
}

module.exports = { policyFor: policyFor, EXAM_RUN_MODE: EXAM_RUN_MODE };
