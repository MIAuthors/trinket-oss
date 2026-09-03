var config = require('config');

// Refuse to create an export on a server that cannot process one.
//
// A queue with no registered handler DISCARDS every job (lib/util/queues.js) —
// on Cloud Run the export worker registers only when RUN_EXPORT_WORKER=true,
// which no Cloud Run deploy sets, so without this guard the export sat
// 'pending' forever while the UI polled it forever.
//
// Bull (Redis) queues have no hasHandlers() — deliberately unguarded: Redis
// PERSISTS jobs, and a separate worker process may legitimately pick them up
// later, so "no handler in this process" is not a failure there.
//
// Replies 200 + { error, exportId } on purpose, not a 5xx: the dashboard
// already understands exactly this body shape (it polls the exportId and
// surfaces the record's errorMessage — see dashboardControl.js), while a 5xx
// lands in its generic rejection branch and loses the message.
// Can this server actually process a queued export? Shared by the guard below
// and by the view layer, so the BUTTON and the ENDPOINT cannot disagree — the
// same contract canImport (#6) and canConnectLms (#197) already follow. A queue
// with no hasHandlers() is Bull/Redis: jobs persist and a separate worker may
// take them later, so that counts as available.
function exportsAvailable(queue) {
  if (!queue) return false;
  if (typeof queue.hasHandlers !== 'function') return true;
  return !!queue.hasHandlers();
}

// Is there anywhere to PUT the archive? lib/workers/exports.js reads
// config.aws.buckets.exports.name directly, so a missing bucket throws inside
// the queue handler — outside any request — and an unhandled exception there
// kills the process. Observed on rba-merge-trial 2026-09-03: three container
// deaths in ninety seconds, one second after each export request, at 11% of
// 2 GiB (so not memory). A missing config key must refuse, not take the server
// down for everyone on the instance.
function exportsConfigured() {
  var buckets = config.aws && config.aws.buckets;
  var bucket = buckets && buckets.exports;
  return !!(bucket && bucket.name);
}

// Both reasons a server cannot export, in one check: no worker to run the job,
// or nowhere to store the result. Same refusal shape either way — 200 with a
// message the dashboard already knows how to surface.
function failIfUnavailable(queue, exportRecord, request) {
  if (!exportsConfigured()) {
    return refuse(exportRecord, request,
      'Exports are not available on this server: no export storage bucket is configured.');
  }
  return failIfNoWorker(queue, exportRecord, request);
}

// Storage-only check, for the in-request export paths in course.js: those
// deliberately do NOT need a queue worker (they build the archive inline), so
// the worker check must not apply to them — but they still need somewhere to
// put the result.
function failIfNoStorage(exportRecord, request) {
  if (exportsConfigured()) return null;
  return refuse(exportRecord, request,
    'Exports are not available on this server: no export storage bucket is configured.');
}

function refuse(exportRecord, request, message) {
  exportRecord.status = 'failed';
  exportRecord.errorMessage = message;
  return exportRecord.save().then(function() {
    return request.fail({ error: message, exportId: exportRecord._id && exportRecord._id.toString() });
  });
}

function failIfNoWorker(queue, exportRecord, request) {
  if (exportsAvailable(queue)) {
    return null;   // a worker is (or may be) available — proceed to enqueue
  }
  exportRecord.status = 'failed';
  exportRecord.errorMessage = 'Exports are not available on this server: no export worker is running.';
  return exportRecord.save().then(function() {
    return request.fail({ error: exportRecord.errorMessage, exportId: exportRecord._id.toString() });
  });
}

module.exports = {
  failIfNoWorker    : failIfNoWorker,
  failIfUnavailable : failIfUnavailable,
  exportsAvailable  : exportsAvailable,
  exportsConfigured : exportsConfigured,
  failIfNoStorage   : failIfNoStorage
};
