'use strict';
// findByIds must not silently break above firestore's `in` limit.
//
// CLAUDE.md tells developers to prefer batched reads ("$in queries, findByIds")
// over per-item lookups — but the firestore backend maps $in straight onto the
// `in` operator, which firestore caps (30 values). So the recommended batching
// API fails at exactly the scale it exists to serve.
//
// ⚠️ This test is MEANINGLESS on mongo, where a large $in just works. It only
// asserts anything on the firestore backend — the same blind spot that hid the
// `X.model || mongoose.model(...)` bug. Keep it running on both legs anyway: it
// costs nothing on mongo and is the only guard on firestore.
const Export = require('../../../lib/models/export');

describe('Model.findByIds beyond the firestore `in` limit', () => {
  it('returns every document for an id list larger than 30', async () => {
    const owner = new User({
      fullname: 'Batch Owner', username: 'batchowner',
      email: 'batchowner@example.com', password: 'password'
    });
    await owner.save();

    const COUNT = 35;                     // > firestore's cap of 30
    const ids = [];
    for (let i = 0; i < COUNT; i++) {
      const rec = await new Export({ _owner: owner.id, type: 'course-submissions', status: 'completed' }).save();
      ids.push(rec.id);
    }

    const found = await Export.findByIds(ids);
    expect(found.length).toBe(COUNT);

    const foundIds = found.map((f) => String(f.id));
    ids.forEach((id) => expect(foundIds).toContain(String(id)));
  });
});
