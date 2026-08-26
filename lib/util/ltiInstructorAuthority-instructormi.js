// gcr instructor-authority: consult the instructormi allowlist (Datastore) via instructorAuth.
// Loaded ONLY when config.lti.instructorAuthority === 'instructormi'; carries the @google-cloud
// /datastore dependency that must never reach oss. Role-independent (trusts trinket's own list).
'use strict';
var instructorAuth = require('./instructorAuth');

function resolveInstructor(ctx) {
  var email = (ctx && ctx.email || '').toLowerCase();
  if (email === '') return Promise.resolve(false);
  if (instructorAuth.isAdminEmail(email)) return Promise.resolve(true);
  return Promise.resolve(instructorAuth.isApprovedInstructor(email))
    .catch(function () { return false; });   // fail closed
}

// Sync, display-only (see the default impl). This profile stamps user.isInstructor
// at login via instructorAuth.ensureInstructorFlag, so the flag is the cheap local
// answer — no Datastore round trip per page render. The route gate still does the
// live lookup, so a revoked instructor sees the link once and then a clear 403,
// rather than the link silently vanishing.
function mayConnectLms(user) {
  return !!(user && user.isInstructor);
}

function getInstructorRecord(email) {
  return Promise.resolve(instructorAuth.getInstructorRecord(email)).catch(function () { return null; });
}

module.exports = { resolveInstructor: resolveInstructor, getInstructorRecord: getInstructorRecord,
                   mayConnectLms: mayConnectLms };
