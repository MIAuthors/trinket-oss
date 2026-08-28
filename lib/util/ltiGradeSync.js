// Ask the LMS whether a human has graded a submission yet, so an instructor does not
// have to mark the same work done twice — once in the LMS, once in trinket.
//
// LTI 1.1 only, for now. Basic Outcomes `readResult` is the same signed POST to the
// same outcomes URL as the reporting call, so it needs NO additional scope and no
// re-registration. The 1.3 equivalent is the AGS Result service, which requires the
// `result.readonly` scope that ltiRegistration does not request today — wiring that
// means updating existing platform registrations, so it is deliberately left out
// (see #209).
//
// Best-effort by contract: this must never fail a page load. Most submissions are not
// LTI-linked at all, and "nobody has graded it yet" is the normal answer, not an error.
'use strict';

var lti11Outcomes     = require('./lti11Outcomes');
var ltiOutcomeContext = require('./ltiOutcomeContext');
var ltiNotifySubmission = require('./ltiNotifySubmission');

// How long to leave a submission alone between asks. Grading is a human action
// measured in minutes-to-days, and each check is an HTTP round trip to the LMS, so
// polling harder buys nothing and costs latency on every dashboard load.
var DEFAULT_THROTTLE_MS = 10 * 60 * 1000;

// Per-request work limits for the batch endpoint. The cap bounds how long an
// instructor waits on the platform AND keeps any batched read under the backend's
// `in` limit; the concurrency keeps us from firing a class-sized burst at an LMS.
var MAX_PER_REQUEST = 25;
var SYNC_CONCURRENCY = 6;

function saveP(submission) {
  return Promise.resolve(submission.save()).catch(function () { return null; });
}

// -> { changed, graded, reason }.  `changed` is true only when this call is what
// flipped the flag, so a caller can decide whether to re-render.
function syncSubmission(submission, opts) {
  opts = opts || {};
  var now = opts.now || Date.now();
  var throttleMs = (opts.throttleMs === undefined) ? DEFAULT_THROTTLE_MS : opts.throttleMs;

  if (!submission) return Promise.resolve({ changed: false, graded: false, reason: 'no submission' });
  if (submission.lmsGraded) {
    return Promise.resolve({ changed: false, graded: true, reason: 'already known graded' });
  }
  var last = submission.lmsCheckedAt ? new Date(submission.lmsCheckedAt).getTime() : 0;
  if (throttleMs && last && (now - last) < throttleMs) {
    return Promise.resolve({ changed: false, graded: false, reason: 'checked recently' });
  }

  var userId = ltiNotifySubmission.creatorId(submission._creator);
  return ltiOutcomeContext.resolveFor(submission, userId).then(function (ctx) {
    if (!ctx.consumer) return { changed: false, graded: false, reason: ctx.reason };
    return lti11Outcomes.readResult({
      serviceUrl : ctx.outcome.serviceUrl,
      consumerKey: ctx.consumer.key,
      secret     : ctx.consumer.secret,
      sourcedId  : ctx.outcome.sourcedId
    }).then(function (res) {
      submission.lmsCheckedAt = new Date(now);
      if (!res.graded) return saveP(submission).then(function () {
        return { changed: false, graded: false, reason: 'not graded yet' };
      });
      submission.lmsGraded   = true;
      submission.lmsGradedAt = new Date(now);
      return saveP(submission).then(function () {
        return { changed: true, graded: true, score: res.score };
      });
    });
  }).catch(function (e) {
    // Never surface to the caller: a page must render whether or not the LMS answers.
    console.error('[lti] grade sync failed (best-effort):', e && e.message);
    return { changed: false, graded: false, reason: 'error' };
  });
}

module.exports = {
  syncSubmission: syncSubmission,
  DEFAULT_THROTTLE_MS: DEFAULT_THROTTLE_MS,
  MAX_PER_REQUEST: MAX_PER_REQUEST,
  SYNC_CONCURRENCY: SYNC_CONCURRENCY
};
