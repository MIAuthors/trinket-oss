// The shape the client expects for one submission: what `trinket-feedback` binds to,
// and what GET .../materials/{id}/submissions returns.
//
// Extracted so the API and the LTI review panel cannot drift apart. They render the
// SAME directive, so a field added for one and missed by the other shows up as a
// silently half-working panel rather than an error.
'use strict';

function iso(v) { return v ? new Date(v).toISOString() : undefined; }

function toSubmissionView(trinket) {
  var opts = {};
  try { opts = JSON.parse(JSON.stringify(trinket.submissionOpts || {})); } catch (e) { opts = {}; }
  var comments = [];
  try { comments = JSON.parse(JSON.stringify(trinket.comments || [])); } catch (e) { comments = []; }
  var view = {
      id              : trinket.id
    , comments        : comments
    , lang            : trinket.lang
    , lastUpdated     : iso(trinket.lastUpdated)
    , startedOn       : iso(trinket.startedOn)
    , submittedOn     : iso(trinket.submittedOn)
    , shortCode       : trinket.shortCode
    , submissionState : trinket.submissionState
  };
  Object.keys(opts).forEach(function (k) {
    if (view[k] === undefined) view[k] = opts[k];
  });
  return view;
}

module.exports = { toSubmissionView: toSubmissionView };
