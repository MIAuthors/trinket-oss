const { test, expect } = require('@playwright/test');

// The LTI review panel (/lti/review-panel/{trinketId}) is where a review launch from
// an LMS grader lands. It hosts the course dashboard's trinket-feedback directive on
// a page of its own, WITHOUT the course app around it.
//
// That is exactly what makes it fragile: the directive quietly relies on context the
// course app provides incidentally. Building this panel hit FOUR separate versions of
// the same failure, each producing an identical symptom — a completely blank pane, no
// server error, nothing in the logs:
//
//   1. window.trinket.config missing        -> trinket-config.js threw at load
//   2. trinket.config / trinket.markdown    -> [$injector:unpr] trinketConfig
//      not declared as module deps
//   3. trinket.util not declared            -> [$injector:unpr] localDateFilter
//   4. moment not loaded                    -> every date interpolation threw
//
// Each was found by deploying and reading the browser console. All four are
// reproducible locally in seconds, which is the point of this spec: assert the panel
// actually RENDERS and that the console is clean, so the next person adding a
// standalone page does not rediscover them one deploy at a time.
test.describe('LTI review panel renders standalone', () => {
  test('shows the feedback form with no console errors', async ({ page, baseURL }) => {
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

    const api = async (method, path, body) => {
      const res = await page.request.fetch(new URL(path, baseURL).toString(), {
        method, headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };

    const rid = Math.random().toString(36).slice(2, 8);

    const courseRes = await api('POST', '/api/courses',
      { name: 'panel ' + rid, description: 'lti review panel spec' });
    expect(courseRes.status, JSON.stringify(courseRes.body).slice(0, 200)).toBe(200);
    const course = courseRes.body.course;

    const lessonRes = await api('POST', `/api/courses/${course.id}/lessons`, { name: 'lesson ' + rid });
    expect(lessonRes.status, JSON.stringify(lessonRes.body).slice(0, 200)).toBe(200);
    const lesson = lessonRes.body.lesson || lessonRes.body.data || lessonRes.body;

    const matRes = await api('POST', `/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      // trinketId '_blank_' is the sentinel that makes the server mint a starter
      // trinket for the assignment; omitting it makes addMaterial 500.
      // The date flags matter: without them setDates leaves trinket.submissionsDue
      // undefined, and submitAssignment then throws reading `.enabled` — surfacing as
      // a misleading 403, because its catch turns every error into forbidden().
      { name: 'assignment ' + rid, type: 'assignment', lang: 'python3', trinketId: '_blank_',
        submissionsDueEnabled: false, submissionsCutoffEnabled: false,
        availableOnEnabled: false, hideAfterEnabled: false });
    expect(matRes.status, JSON.stringify(matRes.body).slice(0, 300)).toBe(200);
    const material = matRes.body.material || matRes.body.data || matRes.body;

    // Submit as the signed-in user: the panel only needs a submission whose course the
    // viewer can give feedback on, and the course owner can.
    const subRes = await api('POST',
      `/api/courses/${course.id}/lessons/${lesson.id}/materials/${material.id}/submissions`,
      { code: { files: {} }, comments: 'spec submission', parent: material.trinket.trinketId });
    expect(subRes.status, JSON.stringify(subRes.body).slice(0, 300)).toBe(200);
    const submissionId = (subRes.body.submission || subRes.body.data || subRes.body).id;
    expect(submissionId, 'need a submission id to open the panel').toBeTruthy();

    await page.goto(`/lti/review-panel/${submissionId}`);

    // The whole point: the directive instantiates and the instructor can respond.
    await expect(page.locator('trinket-feedback')).toBeAttached();
    // NB: it is an <a class="button">, not a <button> — getByRole('button') does
    // not match it.
    await expect(page.locator('a', { hasText: /send feedback/i }).first())
      .toBeVisible({ timeout: 20_000 });
    // Deliberately NOT asserting on the comments editor: ui-ace initialises lazily
    // here and its backing textarea is hidden, so it is a flaky proxy for "the
    // instructor can respond". The Send Feedback control being visible is the real
    // guarantee, and it is what every bootstrap failure destroyed.

    // A blank panel produced console errors and nothing else, so treat them as fatal.
    expect(consoleErrors, 'panel must bootstrap with a clean console:\n' + consoleErrors.join('\n'))
      .toEqual([]);
  });
});
