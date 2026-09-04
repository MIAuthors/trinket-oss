// Statuses are diagnostic infrastructure. When they lie, every tool downstream lies
// with them — and both of these lied while someone was debugging (#211).
//
//   addMaterial       500 on a field the route schema calls optional
//   submitAssignment  403 for ANY failure, including a TypeError
//
// The second one is the expensive kind: it sent a live investigation looking for a
// roles/enrolment problem that did not exist.
const flow = require('../../helpers/flow.cjs');
const Material = require('../../../lib/models/material');

describe('assignment endpoints report honest statuses', () => {
  beforeEach(() => { flow.cookies = {}; });

  async function courseWithLesson(name) {
    await flow.switchUser('user');
    await flow.createCourse({ name: name + ' ' + Math.random().toString(36).slice(2, 6) });
    const course = flow.lastResponse.body.course;
    await flow.post(`/api/courses/${course.id}/lessons`, { name: 'lesson' });
    const b = flow.lastResponse.body;
    return { course, lesson: b.lesson || b.data || b };
  }

  it('400s an assignment with no trinketId instead of 500ing', async () => {
    const { course, lesson } = await courseWithLesson('errstatus');
    await flow.post(`/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      { name: 'no trinket id', type: 'assignment', lang: 'python3' });
    expect(flow.lastResponse.statusCode,
      'a missing optional field must not crash the server').toBe(400);
    expect(JSON.stringify(flow.lastResponse.body)).toMatch(/trinketId/);
  });

  it('still creates an assignment when trinketId is given', async () => {
    const { course, lesson } = await courseWithLesson('errstatus ok');
    await flow.post(`/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      { name: 'with trinket', type: 'assignment', lang: 'python3', trinketId: '_blank_' });
    expect(flow.lastResponse.statusCode).toBe(200);
  });

  it('creates non-assignment materials without needing a trinketId', async () => {
    const { course, lesson } = await courseWithLesson('errstatus page');
    await flow.post(`/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      { name: 'a page', type: 'page', content: 'hello' });
    expect(flow.lastResponse.statusCode).toBe(200);
  });

  it('does not 403 when the trinket carries no date settings at all', async () => {
    // Reproduced backend-independently: Mongoose DEFAULTS submissionsDue into
    // existence, Firestore does not — which is why this crashed on the GCP-shape
    // stack and not in the mongo suite. Stub the shape directly so the guard is
    // proven on either backend.
    const { course, lesson } = await courseWithLesson('errstatus nodates');
    await flow.post(`/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      { name: 'assignment', type: 'assignment', lang: 'python3', trinketId: '_blank_' });
    const created = flow.lastResponse.body.material || flow.lastResponse.body.data || flow.lastResponse.body;

    vi.spyOn(Material, 'findById').mockImplementation(() => Promise.resolve({
      id: created.id,
      trinket: { trinketId: created.trinket.trinketId, name: 'x', lang: 'python3' }  // NO submissionsDue
    }));
    try {
      await flow.post(
        `/api/courses/${course.id}/lessons/${lesson.id}/materials/${created.id}/submissions`,
        { code: { files: {} }, comments: '', parent: created.trinket.trinketId });
      expect(flow.lastResponse.statusCode,
        'a missing date config is not a permissions refusal').not.toBe(403);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not 403 when submitting to an assignment that has no date settings', async () => {
    // The exact shape that used to throw: trinket.submissionsDue undefined ->
    // TypeError -> reported as "forbidden".
    const { course, lesson } = await courseWithLesson('errstatus submit');
    await flow.post(`/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      { name: 'assignment', type: 'assignment', lang: 'python3', trinketId: '_blank_' });
    expect(flow.lastResponse.statusCode).toBe(200);
    const material = flow.lastResponse.body.material || flow.lastResponse.body.data || flow.lastResponse.body;

    await flow.post(
      `/api/courses/${course.id}/lessons/${lesson.id}/materials/${material.id}/submissions`,
      { code: { files: {} }, comments: '', parent: material.trinket.trinketId });

    expect(flow.lastResponse.statusCode,
      'no date config means no date restrictions, not a permissions refusal').not.toBe(403);
    expect(flow.lastResponse.statusCode).toBe(200);
  });
});
