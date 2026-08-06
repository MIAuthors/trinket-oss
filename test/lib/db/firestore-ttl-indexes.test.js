'use strict';

var should = require('chai').should();
var fs     = require('fs');
var path   = require('path');

// Regression (review finding on #77): the Firestore TTL policies in
// firestore.indexes.json must mirror the Mongo TTL indexes on the models —
// otherwise a collection that auto-expires on Mongo grows UNBOUNDED on the
// Firestore deploys (mandi/uindy prod). This originally shipped with ltinonces
// covered but errorevents missing. Each expected (collection, ttlField) below
// corresponds to a model carrying `expireAfterSeconds`; a missing policy fails.
describe('firestore.indexes.json TTL policies mirror the Mongo TTL indexes', function() {
  var indexes = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../../firestore.indexes.json'), 'utf8'));
  var overrides = indexes.fieldOverrides || [];

  // collection group -> the field whose model has a Mongo `expireAfterSeconds` index
  var EXPECTED_TTL = {
    ltinonces:   'expiresAt',   // lib/models/ltiNonce.js
    errorevents: 'created',     // lib/models/errorEvent.js
  };

  Object.keys(EXPECTED_TTL).forEach(function(collection) {
    var field = EXPECTED_TTL[collection];
    it('has a TTL fieldOverride for ' + collection + '/' + field, function() {
      var match = overrides.filter(function(o) {
        return o.collectionGroup === collection && o.fieldPath === field && o.ttl === true;
      });
      match.length.should.be.above(0,
        collection + ' has a Mongo TTL index but no Firestore TTL policy — it grows unbounded on Firestore');
    });
  });
});
