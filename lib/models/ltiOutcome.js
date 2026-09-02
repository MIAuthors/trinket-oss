// LTI 1.1 Basic Outcomes coordinates, captured at launch.
//
// 1.3 splits this across two records: the line-item URL lives on the resource link
// and the student is identified by (iss, sub). 1.1 has no such split — the platform
// hands the tool an opaque lis_result_sourcedid that already encodes "this student,
// this placement", so it is keyed by all three of platform / link / user. The
// outcome service URL rides along because it arrives in the same launch.
//
// Deliberately NOT write-once, unlike LtiResourceLink.agsLineItemUrl: platforms
// reissue sourcedids (an assignment re-created in the LMS mints new ones), and a
// stale sourcedid fails the post silently. Every launch refreshes it.
var model = require('./model');

var schema = {
  platformId     : { type: String, required: true },   // 'lti11:<consumer key>'
  resourceLinkId : { type: String, required: true },
  userId         : { type: String, required: true },   // trinket User id
  sourcedId      : { type: String, required: true },   // lis_result_sourcedid (opaque)
  serviceUrl     : { type: String, required: true }    // lis_outcome_service_url
};

// NB: not `findForUser` — models/model.js reserves that name and rewrites it
// to its own (userId, cb) signature.
function findForPlacement(platformId, resourceLinkId, userId, cb) {
  return this.model.findOne(
    { platformId: platformId, resourceLinkId: resourceLinkId, userId: userId }, cb);
}

// Upsert the coordinates for one (platform, link, user). Best-effort by contract:
// callers must not fail a launch because outcome bookkeeping did not persist.
function record(fields, cb) {
  var self = this;
  var q = { platformId: fields.platformId, resourceLinkId: fields.resourceLinkId, userId: fields.userId };
  return Promise.resolve(self.model.findOne(q)).then(function (existing) {
    if (existing) {
      if (existing.sourcedId === fields.sourcedId && existing.serviceUrl === fields.serviceUrl) {
        return cb ? cb(null, existing) : existing;      // unchanged, no write
      }
      existing.sourcedId  = fields.sourcedId;
      existing.serviceUrl = fields.serviceUrl;
      return Promise.resolve(existing.save()).then(function () {
        return cb ? cb(null, existing) : existing;
      });
    }
    var rec = new self.model(fields);
    return Promise.resolve(rec.save()).then(function () {
      return cb ? cb(null, rec) : rec;
    });
  });
}

var LtiOutcome = model.create('LtiOutcome', {
  schema: schema,
  classMethods: { findForPlacement: findForPlacement, record: record }
}).publicModel;

module.exports = LtiOutcome;
