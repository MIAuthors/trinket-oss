// Shared "show me this student's submission in the LMS grader" decision.
//
// Both LTI versions end up here, but the review URL reaches us differently:
//   1.3  the URL travels as the target_link_uri claim (SpeedGrader never fetches it)
//   1.1  the LMS RELAUNCHES the tool at the URL, so it arrives as the request path
// Same submission id either way, so the authorization and destination live here
// rather than being written twice.
'use strict';

var REVIEW_RE = /\/lti\/review\/([^/?#]+)/;

// Submission id out of a review URL or path; null when this isn't a review launch.
function parseTarget(urlOrPath) {
  var m = REVIEW_RE.exec(urlOrPath || '');
  return m ? m[1] : null;
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
  parseTarget : parseTarget,
  canReview   : canReview,
  redirectPath: redirectPath
};
