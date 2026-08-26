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
function failIfNoWorker(queue, exportRecord, request) {
  if (typeof queue.hasHandlers !== 'function' || queue.hasHandlers()) {
    return null;   // a worker is (or may be) available — proceed to enqueue
  }
  exportRecord.status = 'failed';
  exportRecord.errorMessage = 'Exports are not available on this server: no export worker is running.';
  return exportRecord.save().then(function() {
    return request.fail({ error: exportRecord.errorMessage, exportId: exportRecord._id.toString() });
  });
}

module.exports = { failIfNoWorker: failIfNoWorker };
