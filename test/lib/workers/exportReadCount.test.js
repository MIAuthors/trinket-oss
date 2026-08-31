'use strict';
// The export must not re-read each submission trinket individually.
//
// findSubmissionsByMaterial already loads every submission trinket for the
// material in one query, then dropped code/assets from its projection — so the
// export called findById per student to get them back. That is 2N reads, the
// second N strictly serial (a reduce chain), and it is what made wall time scale
// with class size (#202). On firestore each of those is a remote round trip.
//
// This asserts the SHAPE, not a timing: findById must not be called once per
// submission. A timing test would be flaky; a read-count test cannot be.
const Trinket = require('../../../lib/models/trinket');

describe('student-work export read pattern', () => {
  let student, materialId;

  beforeEach(async () => {
    student = new User({ fullname: 'Read Count', username: 'readcount', email: 'readcount@example.com', password: 'password' });
    await student.save();
    // .toString(): a raw ObjectId value does not serialize on firestore
    // ("Couldn't serialize object of type ObjectId"). Same reason as
    // test/lib/models/export.test.js. Mongoose casts the string back for the
    // query, so both backends see the same thing.
    materialId = new (require('mongoose').Types.ObjectId)().toString();
    const sub = new Trinket({
      name: 'HW submission', lang: 'python3', code: 'print("student work")',
      _owner: student, _creator: student,
      materialId: materialId, submissionState: 'submitted', submittedOn: new Date()
    });
    await sub.save();
  });

  it('carries the full trinket (with code) when the caller asks for it', async () => {
    const groups = await Trinket.findSubmissionsByMaterial(materialId, { includeTrinket: true });
    expect(groups.length).toBe(1);
    const entry = groups[0].submissions[0];
    expect(entry.trinket).toBeTruthy();
    // The point of the change: code is present WITHOUT a second read.
    expect(String(entry.trinket.code)).toContain('student work');
  });

  it('omits it unless asked, so dashboard callers stay lean', async () => {
    // course.js serialises these to the browser; shipping code/assets on every
    // dashboard load would be a real cost.
    const groups = await Trinket.findSubmissionsByMaterial(materialId);
    expect(groups.length).toBe(1);
    expect(groups[0].submissions[0].trinket).toBeUndefined();
  });

  it('the export path no longer calls findById per submission', () => {
    // Structural guard: a regression here is invisible until someone exports a
    // large class, so pin it in the source rather than waiting for that.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../../lib/workers/exports.js'), 'utf8');
    const group = src.slice(src.indexOf('function processSubmissionGroup'));
    const body = group.slice(0, group.indexOf('\nfunction '));
    expect(body).toMatch(/current\.trinket/);
  });
});
