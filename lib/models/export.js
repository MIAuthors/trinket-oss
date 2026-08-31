var mongoose = require('mongoose'),
    ObjectId = mongoose.SchemaTypes.ObjectId,
    model    = require('./model'),
    schema   = {
      _owner        : { type: ObjectId, ref: 'User', required: true, index: true },
      type          : { type: String, enum: ['trinkets', 'course-submissions', 'assignment-submissions'], default: 'trinkets' },
      courseId      : { type: ObjectId, ref: 'Course', index: true },
      materialId    : { type: ObjectId, ref: 'Material', index: true },
      status        : { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
      progress      : {
        total       : { type: Number, default: 0 },
        processed   : { type: Number, default: 0 },
        failed      : { type: Number, default: 0 }
      },
      downloadUrl   : { type: String },
      s3Key         : { type: String },
      expiresAt     : { type: Date, index: true },
      fileSize      : { type: Number },
      trinketCount  : { type: Number },
      errorMessage  : { type: String }
    };

function findByOwner(user) {
  var query = { _owner: user.id };
  // Use lean() to return plain JS objects instead of mongoose documents
  // This avoids circular reference issues with the serialize function
  return this.model.find(query).lean().exec();
}

// An export that has sat 'pending'/'processing' longer than this is dead, not
// in flight: the worker that would have finished it is gone. Anything younger
// still blocks, so a genuine double-click is still refused.
var STALE_EXPORT_MS = 60 * 60 * 1000;   // 1h, matching the between-exports limit

function findPendingOrProcessing(ownerId) {
  // The age test is done in JS, not as a query clause, deliberately: `created`
  // is a Date on mongo but an epoch NUMBER on the firestore backend, so a
  // single $gte cannot be written that compares correctly on both — and adding
  // a range clause beside the $in would need a composite index on firestore.
  //
  // Without this bound a stuck record blocked its owner FOREVER, and worse, the
  // caller handed that dead record's id back to the UI, which polled it
  // indefinitely. Seen live: a record stranded on 2026-08-22 (enqueued on a
  // deploy with no export worker) was still being polled four days later, and
  // every new attempt returned "Export already in progress" pointing at it.
  return this.model.findOne({
    _owner: ownerId,
    status: { $in: ['pending', 'processing'] }
  }).exec().then(function(record) {
    if (!record) return null;
    var started = new Date(record.created).getTime();
    if (!started || isNaN(started)) return record;      // unknown age: treat as live
    return (Date.now() - started) > STALE_EXPORT_MS ? null : record;
  });
}

function findRecentCompleted(ownerId, hoursAgo) {
  var cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  return this.model.findOne({
    _owner: ownerId,
    status: 'completed',
    created: { $gte: cutoff }
  }).exec();
}

var Export = model.create('Export', {
    schema : schema
  , classMethods : {
      findByOwner            : findByOwner,
      findPendingOrProcessing: findPendingOrProcessing,
      findRecentCompleted    : findRecentCompleted
    }
});

module.exports = Export.publicModel;
