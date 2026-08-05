'use strict';
const Export = require('../../../lib/models/export');

describe('Export model scope fields', () => {
  it('defaults type to "trinkets" and accepts submission scope', async () => {
    // The firestore backend stores ObjectId ref fields as string ids (real
    // code passes e.g. course.id, request.user.id — strings); a raw
    // `new mongoose.Types.ObjectId()` value doesn't serialize on firestore.
    // Use a real saved user (like test/lib/models/course.test.js) plus
    // realistic-looking string ids for the course/material refs.
    const owner = new User({ fullname: 'Export Owner', username: 'exportowner', email: 'exportowner@example.com', password: 'password' });
    await owner.save();

    const legacy = await new Export({ _owner: owner.id }).save();
    expect(legacy.type).toBe('trinkets');

    const cid = new (require('mongoose').Types.ObjectId)().toString();
    const mid = new (require('mongoose').Types.ObjectId)().toString();
    const scoped = await new Export({
      _owner: legacy._owner, type: 'assignment-submissions', courseId: cid, materialId: mid
    }).save();
    expect(scoped.type).toBe('assignment-submissions');
    expect(scoped.courseId.toString()).toBe(cid.toString());
    expect(scoped.materialId.toString()).toBe(mid.toString());
  });
});
