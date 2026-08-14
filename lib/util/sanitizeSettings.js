'use strict';

// #128: shared home for the trinket.settings whitelist. Neither Firestore nor
// a mongoose findOneAndUpdate/set path always runs the schema's enum
// validator, so every server write path that assigns settings.runtime from
// caller-supplied data must run it through sanitizeSettings() first, or an
// arbitrary string either lands verbatim on Firestore (unmatched <option>,
// no way for the author to clear it) or gets rejected by Mongo's enum
// validator, silently discarding the whole write. See lib/controllers/
// trinket.js (update/draft/autosave) and lib/controllers/imports.js
// (replace + create paths) for the callers.

// The per-trinket runtime override. Shared by two callers — the `?runtime=`
// query param (lib/controllers/trinket.js `index`) and the persisted
// `settings.runtime` (sanitizeSettings, below) — so it whitelists for both.
// Don't "specialize" this for one caller; add a second function instead if
// their rules ever diverge. Only the two values the runtime router
// understands pass through; anything else becomes '' ("follow the deploy" /
// not reflected into the src).
function validRuntime(value) {
  return (value === 'worker' || value === 'main') ? value : "";
}

// `settings` may arrive from the client (trinket.js) or from a user-uploaded
// zip's metadata.json (imports.js) and gets assigned wholesale by callers.
// Some of those write paths (Draft.findOneAndUpdate, Firestore) do not run
// mongoose validators, so the schema enum does not constrain what lands
// there. Anything that is not one of the three known values becomes ''.
function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  var clean = Object.assign({}, settings);
  if (Object.prototype.hasOwnProperty.call(clean, 'runtime')) {
    clean.runtime = validRuntime(clean.runtime);
  }
  return clean;
}

module.exports = {
  validRuntime     : validRuntime,
  sanitizeSettings : sanitizeSettings
};
