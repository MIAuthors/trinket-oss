// LTI launch nonce — replay protection only (LTI-SPEC §10). Each consumed launch nonce is
// recorded until it expires. Written/read through the ltiNonceStore seam
// (lib/util/ltiNonceStore.js).
//
// Cleanup is declarative and per-backend: on Mongo the TTL index below, on Firestore the
// `ltinonces` fieldOverride in firestore.indexes.json. Neither is automatic — an earlier
// version of this comment asserted a Firestore TTL policy that had never been configured on
// any database, and since no code path deletes a nonce, every launch leaked a row.
var model = require('./model');

var schema = {
  nonce     : { type: String, required: true, index: true },  // findByNonce runs per launch
  expiresAt : { type: Date,   required: true }                // TTL field; see index below
};

function findByNonce(nonce, cb) {
  return this.model.findOne({ nonce: nonce }, cb);
}

var LtiNonce = model.create('LtiNonce', {
  schema: schema,
  // expireAfterSeconds: 0 means "delete once the date in this field has passed" — the
  // field's value IS the expiry time, not an offset from it.
  index: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
  classMethods: { findByNonce: findByNonce }
}).publicModel;

module.exports = LtiNonce;
