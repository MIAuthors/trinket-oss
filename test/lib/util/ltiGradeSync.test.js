// Asking the LMS "has a human graded this yet?" so the instructor doesn't mark the
// same work done twice. The dangerous cases are all "looks graded when it isn't":
// an empty score, a throttled re-check, or an LMS error must never set the flag.
const lti11Outcomes     = require('../../../lib/util/lti11Outcomes');
const ltiOutcomeContext = require('../../../lib/util/ltiOutcomeContext');
const gradeSync         = require('../../../lib/util/ltiGradeSync');

const NOW = 1735000000000;

function submissionWith(extra) {
  return Object.assign({
    id: 'sub-1', courseId: 'c1', materialId: 'm1', _creator: 'user-1',
    save: function () { return Promise.resolve(this); }
  }, extra || {});
}

describe('ltiGradeSync.syncSubmission', () => {
  let reads;
  beforeEach(() => {
    reads = [];
    vi.spyOn(ltiOutcomeContext, 'resolveFor').mockImplementation(() => Promise.resolve({
      link: { platformId: 'lti11:k' },
      outcome: { sourcedId: 'sid-1', serviceUrl: 'https://lms.example/outcomes' },
      consumer: { key: 'k', secret: 's' }
    }));
    vi.spyOn(lti11Outcomes, 'readResult').mockImplementation((a) => {
      reads.push(a); return Promise.resolve({ graded: true, score: 0.9 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks the submission graded when the LMS reports a score', async () => {
    const s = submissionWith();
    const out = await gradeSync.syncSubmission(s, { now: NOW });
    expect(out).toMatchObject({ changed: true, graded: true, score: 0.9 });
    expect(s.lmsGraded).toBe(true);
    expect(s.lmsGradedAt).toEqual(new Date(NOW));
  });

  it('treats a ZERO score as graded', async () => {
    lti11Outcomes.readResult.mockImplementation(() => Promise.resolve({ graded: true, score: 0 }));
    const s = submissionWith();
    expect((await gradeSync.syncSubmission(s, { now: NOW })).graded).toBe(true);
    expect(s.lmsGraded).toBe(true);
  });

  it('does NOT mark graded when nobody has graded it yet, but records the check', async () => {
    lti11Outcomes.readResult.mockImplementation(() => Promise.resolve({ graded: false, score: null }));
    const s = submissionWith();
    const out = await gradeSync.syncSubmission(s, { now: NOW });
    expect(out).toMatchObject({ changed: false, graded: false });
    expect(s.lmsGraded).toBeUndefined();
    expect(s.lmsCheckedAt, 'must record the attempt or we re-ask every page load').toEqual(new Date(NOW));
  });

  it('short-circuits once known graded — no LMS call at all', async () => {
    const s = submissionWith({ lmsGraded: true });
    const out = await gradeSync.syncSubmission(s, { now: NOW });
    expect(out.graded).toBe(true);
    expect(reads.length, 'already graded must not hit the LMS again').toBe(0);
  });

  it('throttles repeat checks', async () => {
    const s = submissionWith({ lmsCheckedAt: new Date(NOW - 60 * 1000) });
    const out = await gradeSync.syncSubmission(s, { now: NOW });
    expect(out.reason).toBe('checked recently');
    expect(reads.length).toBe(0);
  });

  it('asks again once the throttle window has passed', async () => {
    const s = submissionWith({ lmsCheckedAt: new Date(NOW - gradeSync.DEFAULT_THROTTLE_MS - 1) });
    await gradeSync.syncSubmission(s, { now: NOW });
    expect(reads.length).toBe(1);
  });

  it('no-ops quietly when the submission is not LTI-linked', async () => {
    ltiOutcomeContext.resolveFor.mockImplementation(() =>
      Promise.resolve({ reason: 'no resource link for this assignment' }));
    const s = submissionWith();
    const out = await gradeSync.syncSubmission(s, { now: NOW });
    expect(out).toMatchObject({ changed: false, graded: false });
    expect(out.reason).toMatch(/no resource link/);
    expect(reads.length).toBe(0);
  });

  it('never throws when the LMS errors — a page must still render', async () => {
    lti11Outcomes.readResult.mockImplementation(() => Promise.reject(new Error('boom')));
    const s = submissionWith();
    await expect(gradeSync.syncSubmission(s, { now: NOW })).resolves.toMatchObject({ graded: false });
    expect(s.lmsGraded).toBeUndefined();
  });

  it('passes the student-specific sourcedid, not a course-wide one', async () => {
    await gradeSync.syncSubmission(submissionWith(), { now: NOW });
    expect(reads[0]).toMatchObject({ sourcedId: 'sid-1', serviceUrl: 'https://lms.example/outcomes' });
  });
});
