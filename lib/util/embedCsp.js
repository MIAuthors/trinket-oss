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
//   * That opaque origin is also why the policies name this deployment's
//     origin explicitly: inside the program frame `'self'` matches nothing, so
//     a policy relying on it blocks the frame's own runtime libraries.
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
 * @param {string[]} origins  this deployment's own origin(s). Required: the
 *   program frame is sandboxed, so its origin is opaque and 'self' matches
 *   nothing inside it — without these the frame cannot load its own runtime.
 * @returns {string|null} the policy, or null when none applies
 */
function policyFor(cspConfig, pathname, runMode, origins) {
  if (!cspConfig || !cspConfig.enabled) return null;
  if (!isEmbedPath(pathname)) return null;

  // A repeated query parameter (?runMode=calculator&runMode=x) reaches hapi as
  // an ARRAY, which a plain === would read as "not calculator" — letting a
  // duplicated parameter soften the policy while the page's own JS may still
  // read the first value and behave as an exam. If ANY value says calculator,
  // the exam policy applies: duplication can only tighten, never loosen.
  var mode = Array.isArray(runMode)
    ? (runMode.indexOf(EXAM_RUN_MODE) !== -1 ? EXAM_RUN_MODE : runMode[0])
    : runMode;

  var policy = (mode === EXAM_RUN_MODE) ? cspConfig.exam : cspConfig.standard;
  if (!policy) return null;

  var own = (origins || [])
    .filter(Boolean)
    .map(function(o) { return String(o).replace(/\/+$/, ''); })
    .filter(function(o, i, a) { return a.indexOf(o) === i; })
    .join(' ');
  var cdn = (cspConfig.cdnOrigins || []).join(' ');
  var fonts = (cspConfig.fontOrigins || []).join(' ');
  return policy
    .replace(/\{cdn\}/g, cdn)
    .replace(/\{fonts\}/g, fonts)
    .replace(/\{origin\}/g, own)
    .replace(/\s+/g, ' ')       // the YAML block folds across lines
    .replace(/\s+;/g, ';')      // empty {cdn} would otherwise leave "'self' ;"
    .trim();
}

module.exports = { policyFor: policyFor, EXAM_RUN_MODE: EXAM_RUN_MODE };
