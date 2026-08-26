'use strict';
// A stuck export must not block its owner forever.
//
// findPendingOrProcessing had no age bound, so a record left 'pending' — the
// Cloud Run case, where the job was enqueued into a queue with no worker —
// blocked every later export by that user AND handed the UI that dead record's
// id to poll. Seen live: a record stuck since 2026-08-22 was still being polled
// four days later, and each new attempt returned "Export already in progress"
// pointing back at it.
const Export = require('../../../lib/models/export');

async function owner(name) {
  const u = new User({ fullname: name, username: name, email: name + '@example.com', password: 'password' });
  await u.save();
  return u;
}

describe('Export.findPendingOrProcessing ignores stale records', () => {
  it('still blocks while an export is genuinely in flight', async () => {
    const u = await owner('exportfresh');
    await new Export({ _owner: u.id, type: 'course-submissions', status: 'pending' }).save();
    const found = await Export.findPendingOrProcessing(u.id);
    expect(found).toBeTruthy();
  });

  it('does not block on a record left pending long ago', async () => {
    const u = await owner('exportstale');
    const rec = await new Export({ _owner: u.id, type: 'course-submissions', status: 'pending' }).save();
    rec.created = new Date(Date.now() - 25 * 60 * 60 * 1000);   // yesterday
    await rec.save();
    const found = await Export.findPendingOrProcessing(u.id);
    expect(found).toBeNull();
  });
});
