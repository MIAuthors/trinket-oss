// Shared "show me this student's submission in the LMS grader" decision.
//
// Both LTI versions end up here, but the review URL reaches us differently:
//   1.3  the URL travels as the target_link_uri claim (SpeedGrader never fetches it)
//   1.1  the LMS RELAUNCHES the tool at the URL, so it arrives as the request path
// Same submission id either way, so the authorization and destination live here
// rather than being written twice.
'use strict';

var REVIEW_RE = /\/lti\/review\/([^/?#]+)/;

// The 1.1 tool is installed at ONE URL, and Canvas matches a stored
// basic_lti_launch submission back to an installed tool before it will launch it.
// A review URL on its own path matched nothing, so SpeedGrader answered
// "Couldn't find valid settings for this link" and fell back to the modules list
// (MIAuthors #14) — for submitters only, since a non-submitter has no stored URL
// to reject. So 1.1 advertises the submission id as a query param on the
// installed launch path, exactly as per-placement targeting already does with
// ?assignment= (see lti11Verify: query params are folded into the OAuth base).
var LAUNCH_PATH_11 = '/lti11/launch';

// The URL we hand a platform as the place to review this submission.
// 1.3 keeps the dedicated path: it relaunches at the tool's own endpoint with the
// target in a target_link_uri claim, so it is never matched against installed
// tools and has never shown this.
function advertisedUrl(baseUrl, submissionId, opts) {
  if (opts && opts.version === '1.1') {
    return baseUrl + LAUNCH_PATH_11 + '?submission=' + encodeURIComponent(submissionId);
  }
  return baseUrl + '/lti/review/' + submissionId;
}

// Submission id out of a review URL or path; null when this isn't a review launch.
// PATH FORM ONLY, deliberately: this is shared with the 1.3 launch, which hands
// it the target_link_uri claim (controllers/lti.js). Teaching it the query shape
// would make a 1.3 claim carrying ?submission= a review launch when it never was
// — a silent 1.3 behaviour change inside a 1.1 fix. The query form belongs to
// targetFromRequest below, which only the 1.1 launch calls. Raised in review.
//
// Still needed for BOTH versions: every submission a platform stored before the
// #14 fix holds the path form, and those relaunches must keep working.
function parseTarget(urlOrPath) {
  var m = REVIEW_RE.exec(urlOrPath || '');
  return m ? m[1] : null;
}

// The same decision against a live 1.1 request. hapi's request.path carries no
// query string, so the query form is read from the parsed params rather than by
// re-parsing the path.
//
// Read the SAME merged object the signature was verified over
// (controllers/lti.js builds `Object.assign({}, query, body)`, body winning a
// collision). Taking request.query alone would mean a platform that put
// `submission` in the POST body had one value signed and a different one acted
// on. Both are signed, so neither is forgeable — but agreeing with the verifier
// removes the question entirely.
function targetFromRequest(request, signedParams) {
  if (!request) return null;
  var fromPath = parseTarget(request.path);
  if (fromPath) return fromPath;
  var params = signedParams || Object.assign({}, request.query || {}, request.payload || {});
  var q = params.submission;
  return q ? String(q) : null;
}

// A review launch carries no resource_link / trinket_course custom params, so the
// course cannot be resolved from the launch itself. Authorize against the
// SUBMISSION's own course, where the grader holds send-submission-feedback.
function canReview(user, submission) {
  if (!user || !submission) return false;
  return !!user.hasPermission('send-submission-feedback', 'course', { id: submission.courseId });
}

// Land on the feedback PANEL, not the bare embed. The embed shows the student's
// work and allows inline comments, but not the comments-to-student form — so an
// instructor reviewing from the LMS could see the work and had no way to respond
// without leaving for the course dashboard.
function redirectPath(submission) {
  return '/lti/review-panel/' + submission.id;
}

module.exports = {
  REVIEW_RE   : REVIEW_RE,
  LAUNCH_PATH_11   : LAUNCH_PATH_11,
  advertisedUrl    : advertisedUrl,
  parseTarget      : parseTarget,
  targetFromRequest: targetFromRequest,
  canReview   : canReview,
  redirectPath: redirectPath
};
