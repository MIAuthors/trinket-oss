// Resolve everything needed to talk to a 1.1 platform about ONE submission:
// the resource link, that student's outcome coordinates, and the consumer whose
// secret signs the request.
//
// Shared by ltiNotifySubmission (reporting a submission) and ltiGradeSync (asking
// whether a human graded it). Both need the identical three lookups, and drifting
// them apart would mean one path silently working while the other silently does not
// — which is exactly the failure mode this area keeps producing.
'use strict';

var LtiResourceLink = require('../models/ltiResourceLink');
var LtiOutcome      = require('../models/ltiOutcome');
var LtiConsumer     = require('../models/ltiConsumer');

function findAssignmentLinkP(courseId, materialId) {
  return new Promise(function (resolve) {
    LtiResourceLink.findAssignmentLink(courseId, materialId, function (err, link) {
      resolve(err ? null : link);
    });
  });
}
function findOutcomeP(platformId, resourceLinkId, userId) {
  return new Promise(function (resolve) {
    LtiOutcome.findForPlacement(platformId, resourceLinkId, userId, function (err, rec) {
      resolve(err ? null : rec);
    });
  });
}
function findConsumerP(key) {
  return new Promise(function (resolve) {
    LtiConsumer.findByKey(key, function (err, c) { resolve(err ? null : c); });
  });
}

// -> { link, outcome, consumer } with a `reason` when incomplete. Callers treat a
// reason as "nothing to do here", never as an error: most submissions are not
// LTI-linked at all.
// opts.link lets a caller that already fetched the link (notify) avoid a second
// query while still sharing this logic.
function resolveFor(submission, userId, opts) {
  var linkP = (opts && opts.link)
    ? Promise.resolve(opts.link)
    : findAssignmentLinkP(submission.courseId, submission.materialId);
  return linkP.then(function (link) {
    if (!link) return { reason: 'no resource link for this assignment' };
    var m = /^lti11:(.+)$/.exec(String(link.platformId || ''));
    if (!m) return { reason: 'not an lti11 platform', link: link };
    return findOutcomeP(link.platformId, link.resourceLinkId, userId).then(function (outcome) {
      if (!outcome) return { reason: 'no outcome coordinates for this student', link: link };
      return findConsumerP(m[1]).then(function (consumer) {
        if (!consumer || consumer.disabled) {
          return { reason: 'consumer missing or disabled', link: link, outcome: outcome };
        }
        return { link: link, outcome: outcome, consumer: consumer };
      });
    });
  });
}

module.exports = { resolveFor: resolveFor };
