// LTI 1.1 consumer credentials (SPIKE: legacy-platform self-service installs —
// WileyPLUS-hosted Canvas, Developer-Key-gated institutional Canvas).
//
// One record per key/secret pair an instructor mints. The durable user
// identity for 1.1 launches is (iss='lti11:'+key, sub=user_id), reusing
// LtiUserIdentity unchanged.
var model = require('./model');

var schema = {
  key         : { type: String, required: true },   // oauth_consumer_key
  secret      : { type: String, required: true },   // shared secret (HMAC-SHA1)
  name        : { type: String },                   // label: who/what this key serves
  ownerUserId : { type: String },                   // instructor who minted it
  disabled    : { type: Boolean }
};

function findByKey(key, cb) {
  return this.model.findOne({ key: key }, cb);
}

var LtiConsumer = model.create('LtiConsumer', {
  schema: schema,
  classMethods: { findByKey: findByKey }
}).publicModel;

module.exports = LtiConsumer;
