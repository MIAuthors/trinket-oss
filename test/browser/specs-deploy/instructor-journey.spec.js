const { test, expect } = require('@playwright/test');

// The instructor journey against a REAL deployment: sign in, build a course with
// an assignment, export student work, confirm the archive is offered.
//
// Everything else in specs-deploy/ is anonymous and read-only. That was a
// deliberate safety property, but it means the paths instructors actually use
// have no coverage against a deployed server at all — and the two production
// bugs found this week (the /login 500 for an already-authenticated visitor, and
// the export status 500) both live on exactly those paths.
//
// This spec WRITES, so it is opt-in and only runs where credentials are given:
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://... \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/instructor-journey.spec.js
//
// It cleans up the course it creates.
//
// WHERE IT RUNS: deploys using local (form) auth — the Mongo trial and the picup
// VPS. It cannot run where /login is Firebase-driven (the gcr trial, mandi,
// uindy): there is no form to fill. Covering those needs a Firebase ID token
// exchanged at POST /api/auth/session, the same seam the local browser suite
// uses via the auth emulator. uindy is Google-only, so even that would not
// reach it — those paths still need a human.

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
// A session captured once by hand (see save-session.js). This is how the journey
// reaches Google-only deploys, where there is no form to fill: sign in once in a
// real browser, reuse the resulting `__session` cookie thereafter.
const STATE = process.env.SMOKE_STORAGE_STATE;
const fixtures = require('../fixtures');

test.describe('instructor journey', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  let courseId = null;

  test('sign in, build an assignment, export student work', async ({ page, request, baseURL }) => {
    // --- sign in -----------------------------------------------------------
    if (STATE) {
      // Already authenticated by the captured session; just confirm it is live,
      // so an expired capture fails loudly instead of silently testing anonymously.
      const res = await page.goto('/home');
      expect(res.status(), 'captured session should still be valid').toBeLessThan(400);
      expect(page.url(), 'a stale session redirects to /login').not.toMatch(/\/login/);
    } else {
    await page.goto('/login');
    await page.fill('input[name="email"], input[type="email"]', EMAIL);
    await page.fill('input[name="password"], input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 30_000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    expect(page.url(), 'should not still be on /login').not.toMatch(/\/login/);
    }

    // --- an authenticated visitor hitting /login is redirected, not 500'd ---
    // This is #176, which reached production. It only fires when already signed
    // in, which is why it survived every anonymous test.
    const relogin = await page.goto('/login');
    expect(relogin.status(), '/login while signed in must not be a 500').toBeLessThan(500);

    // --- build a course with an assignment ---------------------------------
    const api = async (method, path, body) => {
      const res = await page.request.fetch(new URL(path, baseURL).toString(), {
        method,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };

    // Named from the shared convention so the sweeper can find it if this run
    // dies before its cleanup step.
    const name = fixtures.courseName(fixtures.runId());
    const course = await api('POST', '/api/courses', { name, description: 'deploy smoke' });
    expect(course.status, JSON.stringify(course.body)).toBe(200);
    courseId = (course.body.course || {}).id;
    expect(courseId).toBeTruthy();

    const lesson = await api('POST', `/api/courses/${courseId}/lessons`, { name: 'Week 1' });
    const lessonId = (lesson.body.data || {}).id;
    expect(lessonId).toBeTruthy();

    // type:assignment REQUIRES a trinketId — omitting it 500s (issue #182).
    const material = await api('POST', `/api/courses/${courseId}/lessons/${lessonId}/materials`,
      { name: 'Assignment 1', type: 'assignment', trinketId: '_blank_', lang: 'python3' });
    expect(material.status, JSON.stringify(material.body)).toBe(200);
    expect((material.body.data || {}).trinket, 'assignment should get a prompt trinket').toBeTruthy();

    // --- export student work ----------------------------------------------
    const start = await api('POST', `/api/courses/${courseId}/exports/submissions`);
    // A deploy with no export worker refuses immediately and says why — that is
    // correct behaviour, not a failure of this test.
    if (start.status !== 200 || !(start.body.data || {}).exportId) {
      const why = JSON.stringify(start.body);
      // Two legitimate refusals, both meaning "this deploy cannot export":
      //   * no worker registered (#180 makes this explicit)
      //   * an earlier export is wedged at pending, which on Cloud Run is
      //     permanent and blocks every later attempt (#179)
      expect(why, 'a refusal should explain itself').toMatch(/export worker|not available|already in progress/i);
      test.info().annotations.push({ type: 'note', description: 'export refused: ' + why.slice(0, 120) });
      return;
    }

    const exportId = start.body.data.exportId;
    let status = 'pending';
    for (let i = 0; i < 12 && status !== 'completed' && status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await api('GET', `/api/exports/${exportId}`);
      expect(poll.status, 'export status must never 500 (#178)').toBe(200);
      status = (poll.body.data || {}).status;
    }

    expect(status, 'export should finish').toBe('completed');
    const final = await api('GET', `/api/exports/${exportId}`);
    expect(final.body.data.downloadUrl, 'a completed export should offer a download').toBeTruthy();
    expect(final.body.data.created, 'created must serialize (#178)').toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test.afterEach(async ({ page, baseURL }) => {
    if (!courseId) return;
    await page.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(), { method: 'DELETE' })
      .catch(() => {});
    courseId = null;
  });
});
