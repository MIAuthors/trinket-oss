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

module.exports = { failIfNoWorker: failIfNoWorker, exportsAvailable: exportsAvailable };
