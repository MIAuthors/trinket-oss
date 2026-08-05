'use strict';

// Regression test for the Mongoose `.exec()` compatibility shim on the Firestore
// backend. `findOneAndUpdate`/`updateOne`/`deleteMany` already attached `.exec()`,
// but `findById`, `findByIdAndUpdate`, `deleteOne`, and `count` did not — so any
// caller using the Mongoose `Model.method(...).exec()` idiom (e.g. the export
// worker's `runQuery` helper, and the pre-existing bulk "Download All" export via
// `runQuery(Export.model, 'findByIdAndUpdate', ...)`) crashed on Firestore with
// "... .exec is not a function".
//
// `findById`/`findByIdAndUpdate` are reachable on the public model; `deleteOne`/
// `count` are reached only through the raw backend model (as the worker does),
// and are exercised end-to-end by the export-worker firestore tests. Here we pin
// the two public-surface methods plus assert the `.exec` shim is present. Passes
// on BOTH the mongoose and firestore profiles.
const Export = require('../../../lib/models/export');

describe('Firestore backend .exec() shim', () => {
  function ownerId() { return String(new (require('mongoose').Types.ObjectId)()); }

  it('findById(...).exec() resolves the saved document', async () => {
    const saved = await new Export({ _owner: ownerId(), status: 'pending' }).save();
    const found = await Export.findById(saved.id).exec();
    expect(found).toBeTruthy();
    expect(found.id).toBe(saved.id);
  });

  it('findByIdAndUpdate(...).exec() has .exec() and applies the update', async () => {
    const saved = await new Export({ _owner: ownerId(), status: 'pending' }).save();
    const query = Export.findByIdAndUpdate(saved.id, { status: 'processing' }, { new: true });
    expect(typeof query.exec).toBe('function');   // the shim under test
    await query.exec();
    const reloaded = await Export.findById(saved.id).exec();
    expect(reloaded.status).toBe('processing');
  });
});
