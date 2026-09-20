// Picking the submission to announce to the LMS.
//
// notifyOnCoordinates used findByUserAndMaterial, which returns EVERY trinket
// for a (student, material) -- drafts included -- ordered by `created`, then
// filtered in JavaScript. Two problems, both live:
//
//   1. `created` is not submission order. updateMySubmission can stamp
//      submittedOn on an older document after a newer attempt exists, so the
//      first `created`-ordered row is not necessarily the newest SUBMISSION.
//   2. On Firestore every returned document is a billed read, so a student who
//      iterates pays one read per revision on every graded launch. Measured on
//      a trial: 3 documents for one pair after two days of light use.
//
// findNewestSubmission asks the database for exactly the row we want.
//
// ⚠️ Backend divergence this test exists to pin: ordering by submittedOn in
// Firestore implicitly EXCLUDES documents that lack the field, so drafts fall
// out for free -- but Mongo sorts missing fields in rather than dropping them.
// The query carries an explicit existence filter so both backends agree, and
// the draft below is what proves it on the mongo leg.
const Trinket = require('../../../lib/models/trinket');

const hexId = () => Array.from({ length: 24 },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('Trinket.findNewestSubmission', () => {
  it('picks the newest SUBMISSION, not the newest document, and ignores drafts', async () => {
    const creator = hexId(), materialId = hexId();
    const mk = (name, created, submittedOn) => {
      const t = new Trinket({
        name: name, lang: 'python3', _creator: creator, _owner: creator,
        courseId: hexId(), materialId: materialId, created: created
      });
      if (submittedOn) t.submittedOn = submittedOn;
      return t.save();
    };

    // Created FIRST, submitted LAST -- the one that must win. This is the
    // updateMySubmission case: an older attempt re-submitted after a newer one.
    await mk('older document, newest submission',
             new Date('2026-09-01T09:00:00Z'), new Date('2026-09-05T17:00:00Z'));
    // Created SECOND, submitted EARLIER -- wins a `created` sort, and is wrong.
    await mk('newer document, older submission',
             new Date('2026-09-02T09:00:00Z'), new Date('2026-09-03T10:00:00Z'));
    // Created LAST, never submitted -- must not be announced at all.
    await mk('draft, never submitted', new Date('2026-09-04T09:00:00Z'), null);

    const got = await Trinket.findNewestSubmission(creator, materialId);

    expect(got, 'a submission should be found').toBeTruthy();
    expect(got.name).toBe('older document, newest submission');
    expect(got.submittedOn, 'never announce an unsubmitted draft').toBeTruthy();
  });

  it('returns nothing when the student has only drafts', async () => {
    const creator = hexId(), materialId = hexId();
    await new Trinket({
      name: 'draft only', lang: 'python3', _creator: creator, _owner: creator,
      courseId: hexId(), materialId: materialId
    }).save();

    const got = await Trinket.findNewestSubmission(creator, materialId);
    expect(got, 'a draft is not a submission').toBeFalsy();
  });

  it('does not reach across students or materials', async () => {
    const mine = hexId(), theirs = hexId(), materialId = hexId();
    await new Trinket({
      name: 'their work', lang: 'python3', _creator: theirs, _owner: theirs,
      courseId: hexId(), materialId: materialId, submittedOn: new Date()
    }).save();

    const got = await Trinket.findNewestSubmission(mine, materialId);
    expect(got, "another student's submission must not be returned").toBeFalsy();
  });
});
