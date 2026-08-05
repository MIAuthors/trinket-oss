'use strict';
const Export = require('../../../lib/models/export');

describe('Export model scope fields', () => {
  it('defaults type to "trinkets" and accepts submission scope', async () => {
    const legacy = await new Export({ _owner: new (require('mongoose').Types.ObjectId)() }).save();
    expect(legacy.type).toBe('trinkets');

    const cid = new (require('mongoose').Types.ObjectId)();
    const mid = new (require('mongoose').Types.ObjectId)();
    const scoped = await new Export({
      _owner: legacy._owner, type: 'assignment-submissions', courseId: cid, materialId: mid
    }).save();
    expect(scoped.type).toBe('assignment-submissions');
    expect(scoped.courseId.toString()).toBe(cid.toString());
    expect(scoped.materialId.toString()).toBe(mid.toString());
  });
});
