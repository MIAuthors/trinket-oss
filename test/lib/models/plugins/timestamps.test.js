// Production bug (uindy, 2026-08-22): GET /api/exports/:id returned 500 with
// "exportRecord.created.toISOString is not a function".
//
// This plugin is applied to EVERY schema, and its pre-save hook wrote
// `Date.now()` — a NUMBER — into fields declared `{ type: Date }`. Mongoose
// casts that on the way in, so the Mongo deploys never noticed. The Firestore
// backend does no casting, so it stored a Number and every read got a Number.
const timestamps = require('../../../../lib/models/plugins/timestamps');

function fakeSchema() {
  const added = [];
  const schema = {
    added,
    hook: null,
    add(def) { added.push(def); return schema; },
    pre(evt, fn) { if (evt === 'save') schema.hook = fn; return schema; },
  };
  return schema;
}

function runHook(schema, doc) {
  let called = false;
  schema.hook.call(doc, () => { called = true; });
  return called;
}

describe('timestamps plugin', () => {
  it('declares both fields as Date', () => {
    const schema = fakeSchema();
    timestamps(schema);
    const fields = Object.assign({}, ...schema.added);
    expect(fields.created.type).toBe(Date);
    expect(fields.lastUpdated.type).toBe(Date);
  });

  it('writes real Dates, not epoch numbers', () => {
    // The whole bug: a Number here reaches Firestore uncast, and every later
    // .toISOString() on it throws.
    const schema = fakeSchema();
    timestamps(schema);
    const doc = { isModified: () => true };
    expect(runHook(schema, doc)).toBe(true);
    expect(doc.created).toBeInstanceOf(Date);
    expect(doc.lastUpdated).toBeInstanceOf(Date);
    expect(typeof doc.created).not.toBe('number');
  });

  it('does not overwrite a created value that already exists', () => {
    const schema = fakeSchema();
    timestamps(schema);
    const original = new Date('2020-01-01T00:00:00Z');
    const doc = { isModified: () => true, created: original, lastUpdated: original };
    runHook(schema, doc);
    expect(doc.created).toBe(original);
    expect(doc.lastUpdated).not.toBe(original);   // lastUpdated always moves
  });

  it('skips unmodified documents', () => {
    const schema = fakeSchema();
    timestamps(schema);
    const doc = { isModified: () => false };
    runHook(schema, doc);
    expect(doc.created).toBeUndefined();
  });
});
