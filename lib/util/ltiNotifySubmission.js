// Best-effort: when a student submits an LTI-launched assignment, announce the submission to the LMS
// gradebook (AGS Score, no grade) so it is reviewable in the LMS grader. Never throws to the caller.
'use strict';
var config          = require('config');
var LtiResourceLink = require('../models/ltiResourceLink');
var LtiPlatform     = require('../models/ltiPlatform');
var LtiUserIdentity = require('../models/ltiUserIdentity');
var LtiOutcome      = require('../models/ltiOutcome');
var LtiConsumer     = require('../models/ltiConsumer');
var Trinket         = require('../models/trinket');
var ltiAgs          = require('./ltiAgs');
var lti11Outcomes   = require('./lti11Outcomes');
var ltiOutcomeContext = require('./ltiOutcomeContext');
var ltiReview       = require('./ltiReview');

function findAssignmentLinkP(courseId, materialId) {
  return new Promise(function(resolve) {
    LtiResourceLink.findAssignmentLink(courseId, materialId, function(err, link) { resolve(err ? null : link); });
  });
}
function findPlatformP(id) {
  return new Promise(function(resolve) { LtiPlatform.findById(id, function(err, p) { resolve(err ? null : p); }); });
}
function findOutcomeP(platformId, resourceLinkId, userId) {
  return new Promise(function(resolve) {
    LtiOutcome.findForPlacement(platformId, resourceLinkId, userId, function(err, rec) { resolve(err ? null : rec); });
  });
}
function findConsumerP(key) {
  return new Promise(function(resolve) {
    LtiConsumer.findByKey(key, function(err, c) { resolve(err ? null : c); });
  });
}

// LTI 1.1 has no AGS: replaceResult with resultData/ltiLaunchUrl is the only way to
// tell the platform a submission exists and where to view it. Platform ids for 1.1
// are synthesized as 'lti11:<consumer key>' at launch (see controllers/lti.js).
function notify11(link, userId, reviewUrl, submission) {
  return ltiOutcomeContext.resolveFor(submission, userId, { link: link }).then(function (ctx) {
    if (!ctx.consumer) {
      // The common one is 'no outcome coordinates for this student': 1.1 can
      // only post with a per-(student, placement) sourcedid, and we only get
      // one when that student launches that graded placement. Logged rather
      // than swallowed — notifyOnCoordinates exists to repair exactly this.
      say('skipped (1.1) — ' + ctx.reason, submission, { user: userId });
      return null;
    }
    return lti11Outcomes.postSubmission({
      serviceUrl : ctx.outcome.serviceUrl,
      consumerKey: ctx.consumer.key,
      secret     : ctx.consumer.secret,
      sourcedId  : ctx.outcome.sourcedId,
      launchUrl  : reviewUrl
      // no score: trinket has no concept of a grade
    }).then(function (res) {
      say('reported to the LMS (1.1 Basic Outcomes)', submission, { user: userId });
      return res;
    });
  });
}

function findSubP(userId, iss) {
  return new Promise(function(resolve) {
    LtiUserIdentity.findByUserAndIss(userId, iss, function(err, idn) { resolve(err ? null : idn); });
  });
}

// The creator's user ID, whatever shape `_creator` arrives in. Mongoose casts
// the assignment `_creator: request.user` to an ObjectId, so toString() was the
// id; the Firestore model layer keeps the user DOCUMENT in memory (it coerces
// to an id only at write time), so toString() there was "[object Object]" and
// the identity lookup silently found nothing — the AGS needs-grading call
// never fired on any Firestore deploy. Found live in the 2026-08-24 Canvas
// rehearsal; pinned by test/lib/util/ltiNotifySubmission.test.js.
function creatorId(creator) {
  if (!creator) return creator;
  if (typeof creator === 'object') {
    if (typeof creator._id !== 'undefined') return String(creator._id);
    if (typeof creator.id  !== 'undefined') return String(creator.id);
  }
  return String(creator);
}

// Every exit below used to be silent, including success. That is why a live
// course could report half its submissions to the LMS and none of the other
// half with nothing in the logs to say so — it took a database reconciliation
// to find. One line per outcome makes the next case readable straight from the
// request log.
function say(what, submission, extra) {
  console.log('[lti] submission notify: ' + what,
    Object.assign({ submission: submission && submission.id,
                    material: submission && submission.materialId }, extra || {}));
}

function notify(submission) {
  var userId = creatorId(submission._creator);
  return findAssignmentLinkP(submission.courseId, submission.materialId).then(function(link) {
    if (!link) { say('skipped — material is not an LTI assignment', submission); return null; }
    // The two versions get DIFFERENT review URLs, because only one of them has to
    // be matched back to an installed tool. See ltiReview.advertisedUrl.
    if (!link.agsLineItemUrl) {
      return notify11(link, userId,
                      ltiReview.advertisedUrl(config.url, submission.id, { version: '1.1' }),
                      submission);
    }
    var reviewUrl = ltiReview.advertisedUrl(config.url, submission.id);
    return findPlatformP(link.platformId).then(function(platform) {
      if (!platform) { say('skipped (1.3) — platform record missing', submission); return null; }
      return findSubP(userId, platform.issuer).then(function(identity) {
        if (!identity) {
          say('skipped (1.3) — no LTI identity for this user on ' + platform.issuer, submission, { user: userId });
          return null;
        }
        return ltiAgs.postSubmission(platform, link.agsLineItemUrl, {
          userId: identity.sub, reviewUrl: reviewUrl, submittedAt: submission.submittedOn || new Date()
        }).then(function (res) {
          say('reported to the LMS (1.3 AGS)', submission, { user: userId });
          return res;
        });
      });
    });
  }).catch(function(e) {
    console.error('[lti] submission notify failed (best-effort):', e && e.message);
    return null;
  });
}

// Report a submission whose Basic Outcomes coordinates only arrived LATER.
//
// 1.1 can report a submission only with a per-(student, placement) sourcedid,
// handed over just when that student launches that graded assignment. A student
// who reached the work another way — a course or topic link, a bookmark — and
// submitted had no coordinates at submit time, so notify() no-opped and the LMS
// grader said "nothing submitted" while the work sat in trinket. Measured on a
// live course: 135 of 273 student-assignment pairs had no coordinates.
//
// Called from the 1.1 launch once coordinates are captured or reissued, so the
// course heals as students click through their assignments. Best-effort like
// everything on this path: a launch must never fail over gradebook bookkeeping.
function notifyOnCoordinates(platformId, resourceLinkId, userId) {
  return Promise.resolve().then(function () {
    return new Promise(function (resolve) {
      LtiResourceLink.findByLink(platformId, resourceLinkId, function (err, link) {
        resolve(err ? null : link);
      });
    });
  }).then(function (link) {
    // Only a graded assignment placement can carry a submission. A topic or
    // course link legitimately has nothing to report.
    if (!link || link.targetType !== 'assignment' || !link.targetId) return null;
    return Promise.resolve(Trinket.findByUserAndMaterial(userId, link.targetId))
      .then(function (list) {
        // findByUserAndMaterial sorts newest first; only submitted work counts,
        // an in-progress draft is not a submission.
        var submission = (list || []).filter(function (t) { return t && t.submittedOn; })[0];
        if (!submission) return null;
        say('coordinates arrived late — reporting existing submission', submission, { user: userId });
        return notify(submission);
      });
  }).catch(function (e) {
    console.error('[lti] late-coordinate notify failed (best-effort):', e && e.message);
    return null;
  });
}

module.exports = {
  notify: notify,
  notifyOnCoordinates: notifyOnCoordinates,
  creatorId: creatorId
};
