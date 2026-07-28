/* Possible metrics to be gleaned from this model
 * - time to resolve
 * - avg resolution attempts
 * - avg attempts/resolution
 * - avg attempts/unresolved
 * - avg resolved in a session
 * - avg unresolved in a session session
 */

var model  = require('./model')
  , config = require('config')
  , schema = {
      // one of three possible error states
      // - encountered: the error has just been introduced
      // - repeated: an unsuccessful attempt to resolve the error
      // - resolved: a successful attempt to resolve the error
      //   * note: doesn't imply working code, just this error went away
      state : { type: String, enum: ["encountered", "repeated", "resolved"] }
      // unique id per coding editor session
      , session : { type: String, required: true }
      // for a given session id, all ErrorEvent objects
      // with the same 'group' constitute all of the attempts
      // to fix the error (should all be same type and message)
      , group : { type: Number, required: true }
      // full string of error message
      , error : { type: String, required: true }
      // the broad category error type (ParseError, NameError, etc)
      , type : { type: String, index: true }
      // the main body of the message, excluding type and line
      , message : { type: String, required: true }
      // the line number on which the error occurred
      , line : { type: Number }
      // code at time of error
      , code : { type: String, required: true, default: '' }
      // the number of attempts to correct the error so far
      // 0 implies a state of 'encountered'
      , attempt : { type: Number, required: true }
      // the code change that was made in an attempt to fix the error
      // stored as a git patch without the header info (see JsDiff.createPatch)
      , delta : { type: String }
      // any new error introduced in the attempt to fix this error
      , introduced : { type: String }
      // the amount of time since the previous error in this group
      , elapsed : { type: Number }
      // the amount of time since this error group was first introduced
      , totalElapsed : { type: Number }
      // the trinket shortCode (if it is a "real" trinket)
      , shortCode : { type: String }
      // type of trinket
      , lang : { type: String, enum: config.constants.trinketLangs, default: 'python' }
      // optional arbitrary label used for additional information
      // For example, if this error is being tracked as part of an A/B test
      // the label might specify which version of the experiment was active
      , label : { type: String }
    };

module.exports = model.create('ErrorEvent', {
  schema : schema,
  index: [
    [{ lang: 1, state: 1, type: 1, session: 1 }]
    // Append-per-error with no cleanup path anywhere: this collection only ever
    // grows. 400 days keeps a full academic year (so year-over-year and
    // cross-cohort comparison still work) while bounding it. `created` comes from
    // the timestamps plugin, so this applies to existing documents with no
    // backfill.
    , [{ created: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 }]
  ]
}).publicModel;
