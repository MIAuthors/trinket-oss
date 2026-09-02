// POST /api/courses/{courseId}/materials/{materialId}/lms-grades
//
// Refreshes "has the LMS graded this?" for one assignment, so an instructor is not
// asked to mark work done twice. It is a SEPARATE endpoint from the dashboard fetch
// because it talks to the LMS, and LMS-side trouble is invisible to us — a stalled or
// erroring platform must never present as "trinket is slow" on a page load.
//
// So the behaviours that matter are the defensive ones: it must not block, must not
// fail the caller, must not re-ask about work it already knows about, and must not
// fire a class-sized burst at the platform.
const flow       = require('../../helpers/flow.cjs');
const Trinket    = require('../../../lib/models/trinket');
const gradeSync  = require('../../../lib/util/ltiGradeSync');

describe('POST .../lms-grades', () => {
  let synced;
  beforeEach(() => {
    flow.cookies = {};
    synced = [];
    vi.spyOn(gradeSync, 'syncSubmission').mockImplementation((sub) => {
      synced.push(String(sub.id));
      return Promise.resolve({ changed: true, graded: true, score: 1 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function ownedCourse() {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'lms ' + Math.random().toString(36).slice(2, 6) });
    return flow.lastResponse.body.course;
  }

  function stubSubmissions(list) {
    vi.spyOn(Trinket, 'find').mockImplementation(() => Promise.resolve(list));
  }

  const sub = (id, extra) => Object.assign(
    { id, submissionState: 'submitted', save: () => Promise.resolve() }, extra || {});

  it('syncs submitted work and reports what the LMS had graded', async () => {
    const course = await ownedCourse();
    stubSubmissions([sub('a'), sub('b')]);

    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});

    expect(flow.lastResponse.statusCode).toBe(200);
    expect(synced.sort()).toEqual(['a', 'b']);
    expect(flow.lastResponse.body.graded.sort()).toEqual(['a', 'b']);
  });

  it('skips work it already knows is graded', async () => {
    const course = await ownedCourse();
    stubSubmissions([sub('a', { lmsGraded: true }), sub('b')]);
    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});
    expect(synced, 'must not re-ask the LMS about a known grade').toEqual(['b']);
  });

  it('skips work that has not been submitted', async () => {
    const course = await ownedCourse();
    stubSubmissions([sub('a', { submissionState: 'started' }), sub('b')]);
    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});
    expect(synced).toEqual(['b']);
  });

  it('respects the recheck throttle', async () => {
    const course = await ownedCourse();
    stubSubmissions([sub('a', { lmsCheckedAt: new Date() }), sub('b')]);
    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});
    expect(synced).toEqual(['b']);
  });

  it('caps the work per request and reports the remainder', async () => {
    const course = await ownedCourse();
    const many = [];
    for (let i = 0; i < gradeSync.MAX_PER_REQUEST + 7; i++) { many.push(sub('s' + i)); }
    stubSubmissions(many);

    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});

    expect(synced.length, 'one request must not wait on an unbounded number of LMS calls')
      .toBe(gradeSync.MAX_PER_REQUEST);
    expect(flow.lastResponse.body.remaining).toBe(7);
  });

  it('never fails the caller when the LMS errors', async () => {
    const course = await ownedCourse();
    stubSubmissions([sub('a')]);
    gradeSync.syncSubmission.mockImplementation(() => Promise.reject(new Error('lms down')));

    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});

    expect(flow.lastResponse.statusCode, 'an enrichment must not break the caller').toBe(200);
    expect(flow.lastResponse.body.graded).toEqual([]);
  });

  it('refuses someone without permission to view submissions', async () => {
    const course = await ownedCourse();
    stubSubmissions([sub('a')]);
    await flow.switchUser('user2');
    await flow.post(`/api/courses/${course.id}/materials/m1/lms-grades`, {});
    expect(flow.lastResponse.statusCode).toBe(403);
    expect(synced).toEqual([]);
  });
});
