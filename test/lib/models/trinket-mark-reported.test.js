// Marking a submission as reported must not clobber the student's work.
//
// markReported set two fields on a Trinket loaded BEFORE the LMS round trip and
// then called save(). On Firestore save() is doc.set(data) -- a whole-document
// overwrite with no merge -- so anything written to that row during the post
// was silently reverted to the snapshot taken before it.
//
// The row has a real concurrent writer: controllers/course.js updateMySubmission
// edits the SAME document in place (code, assets, settings, submittedOn,
// submissionState, comments) and saves it. So the loss is not bookkeeping, it is
// the student's resubmitted code -- and because save() stamps lastUpdated, the
// revert looks like a legitimate recent edit rather than a bug.
//
// The window is one LMS round trip on a launch-triggered repair, so this is
// unlikely. It is fixed anyway because it fails in the direction of destroying
// student work, whereas losing the marker merely means reporting again next
// launch, which the marker design already tolerates.
const Trinket = require('../../../lib/models/trinket');
const notify  = require('../../../lib/util/ltiNotifySubmission');

const hexId = () => Array.from({ length: 24 },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('marking a submission reported', () => {
  it('does not revert a concurrent edit made while the LMS post was in flight', async () => {
    const creator = hexId(), materialId = hexId();
    const original = new Trinket({
      name: 'Submission', lang: 'python3', _creator: creator, _owner: creator,
      courseId: hexId(), materialId: materialId,
      code: 'print("first attempt")', submittedOn: new Date('2026-09-05T10:00:00Z')
    });
    await original.save();

    // The repair loads the row, then posts to the LMS. Model that by holding the
    // stale in-memory copy while a second writer updates the row underneath --
    // exactly what updateMySubmission does.
    const stale = await Trinket.findById(original.id);

    const concurrent = await Trinket.findById(original.id);
    concurrent.code = 'print("second attempt")';
    concurrent.submittedOn = new Date('2026-09-05T10:00:03Z');
    await concurrent.save();

    // ...and only now does the post return and the marker get written.
    await notify._markReported(stale, 'sourced-abc');

    const after = await Trinket.findById(original.id);
    expect(after.code, "the student's newer code must survive being marked")
      .toBe('print("second attempt")');
    expect(after.ltiReportedSourcedId, 'the marker must still be recorded').toBe('sourced-abc');
    expect(after.ltiReportedAt, 'the marker timestamp must be recorded').toBeTruthy();
  });

  it('records the marker on a row nobody else touched', async () => {
    const creator = hexId();
    const t = new Trinket({
      name: 'Quiet Submission', lang: 'python3', _creator: creator, _owner: creator,
      courseId: hexId(), materialId: hexId(),
      code: 'print("only attempt")', submittedOn: new Date()
    });
    await t.save();

    await notify._markReported(t, 'sourced-xyz');

    const after = await Trinket.findById(t.id);
    expect(after.ltiReportedSourcedId).toBe('sourced-xyz');
    expect(after.code, 'an ordinary mark must leave the work alone').toBe('print("only attempt")');
  });
});
