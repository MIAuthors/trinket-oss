// Best-effort: when a student submits an LTI-launched assignment, announce the submission to the LMS
// gradebook (AGS Score, no grade) so it is reviewable in the LMS grader. Never throws to the caller.
'use strict';
var config          = require('config');
var LtiResourceLink = require('../models/ltiResourceLink');
var LtiPlatform     = require('../models/ltiPlatform');
var LtiUserIdentity = require('../models/ltiUserIdentity');
var LtiOutcome      = require('../models/ltiOutcome');
var LtiConsumer     = require('../models/ltiConsumer');
var ltiAgs          = require('./ltiAgs');
var lti11Outcomes   = require('./lti11Outcomes');

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
function notify11(link, userId, reviewUrl) {
  var m = /^lti11:(.+)$/.exec(String(link.platformId || ''));
  if (!m) return null;                                   // a 1.3 link with no line item
  return findOutcomeP(link.platformId, link.resourceLinkId, userId).then(function(rec) {
    if (!rec) return null;                               // launch carried no outcomes coordinates
    return findConsumerP(m[1]).then(function(consumer) {
      if (!consumer || consumer.disabled) return null;
      return lti11Outcomes.postSubmission({
        serviceUrl : rec.serviceUrl,
        consumerKey: consumer.key,
        secret     : consumer.secret,
        sourcedId  : rec.sourcedId,
        launchUrl  : reviewUrl
        // no score: trinket has no concept of a grade
      });
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

function notify(submission) {
  var userId = creatorId(submission._creator);
  return findAssignmentLinkP(submission.courseId, submission.materialId).then(function(link) {
    if (!link) return null;                          // not an LTI assignment → no-op
    var reviewUrl = config.url + '/lti/review/' + submission.id;
    if (!link.agsLineItemUrl) return notify11(link, userId, reviewUrl);
    return findPlatformP(link.platformId).then(function(platform) {
      if (!platform) return null;
      return findSubP(userId, platform.issuer).then(function(identity) {
        if (!identity) return null;
        return ltiAgs.postSubmission(platform, link.agsLineItemUrl, {
          userId: identity.sub, reviewUrl: reviewUrl, submittedAt: submission.submittedOn || new Date()
        });
      });
    });
  }).catch(function(e) {
    console.error('[lti] submission notify failed (best-effort):', e && e.message);
    return null;
  });
}

module.exports = { notify: notify };
