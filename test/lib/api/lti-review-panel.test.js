// The feedback panel as a standalone page — where an LTI review launch now lands.
//
// The point of the route is that authorization happens on the SERVER: reaching the
// page is the permission check, and the client is handed pre-resolved objects. So
// the tests that matter are the refusals, plus proof that the page actually carries
// the data the directive binds to (an empty shell would render and look fine).
const flow     = require('../../helpers/flow.cjs');
const Trinket  = require('../../../lib/models/trinket');
const Material = require('../../../lib/models/material');

describe('GET /lti/review-panel/{trinketId}', () => {
  beforeEach(() => { flow.cookies = {}; });
  afterEach(() => vi.restoreAllMocks());

  async function ownedCourse() {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Panel ' + Math.random().toString(36).slice(2, 7) });
    return flow.lastResponse.body.course;
  }

  function stub(sub, material) {
    vi.spyOn(Trinket, 'findById').mockImplementation(() => Promise.resolve(sub));
    vi.spyOn(Material, 'findById').mockImplementation(() => Promise.resolve(
      material === undefined ? { id: 'mat-1', name: 'HW 1', toJSON: () => ({ id: 'mat-1', name: 'HW 1' }) } : material));
  }

  it('renders the panel with the submission and material embedded', async () => {
    const course = await ownedCourse();
    stub({ id: 'sub-p1', lang: 'python3', courseId: course.id, materialId: 'mat-1',
           comments: [], submissionState: 'submitted', shortCode: 'abc123',
           lastUpdated: new Date(), submittedOn: new Date() });

    await flow.get('/lti/review-panel/sub-p1');

    expect(flow.lastResponse.statusCode).toBe(200);
    const html = String(flow.lastResponse.body || '');
    expect(html, 'must host the real directive').toContain('<trinket-feedback');
    expect(html, 'must embed the resolved objects').toContain('TRINKET_REVIEW_PANEL');
    expect(html).toContain('sub-p1');
    // No site chrome: this renders inside an LMS grader pane.
    expect(html, 'no top nav inside an LMS iframe').not.toContain('Main Navigation');
  });

  it('refuses a user without feedback permission on that course', async () => {
    await ownedCourse();
    stub({ id: 'sub-p2', lang: 'python3', courseId: '5f000000000000000000000a', materialId: 'mat-1',
           comments: [], submissionState: 'submitted' });

    await flow.get('/lti/review-panel/sub-p2');
    expect(flow.lastResponse.statusCode).toBe(403);
  });

  it('404s an unknown submission', async () => {
    await ownedCourse();
    stub(null);
    await flow.get('/lti/review-panel/nope');
    expect(flow.lastResponse.statusCode).toBe(404);
  });

  it('still renders when the material has gone missing', async () => {
    // A deleted material must not take the panel down — the instructor still needs
    // to read the submission and respond.
    const course = await ownedCourse();
    stub({ id: 'sub-p3', lang: 'python3', courseId: course.id, materialId: 'gone',
           comments: [], submissionState: 'submitted' }, null);
    await flow.get('/lti/review-panel/sub-p3');
    expect(flow.lastResponse.statusCode).toBe(200);
  });
});
