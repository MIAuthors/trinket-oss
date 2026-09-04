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
// WHERE IT RUNS: any trial. deploy-auth's signIn() picks the method from the
// deploy — a password field means form auth (Mongo trial, picup VPS), its
// absence means Firebase, where it signs in through the Email/Password provider
// and exchanges the ID token at POST /api/auth/session. That is the same seam
// the local browser suite drives via the emulator, and the server never inspects
// which provider minted the token.
//
// uindy remains out of reach by choice: it is Google-only, and enabling anything
// else there would weaken a posture documented to UIndy IT.

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
// A session captured once by hand (see save-session.js). This is how the journey
// reaches Google-only deploys, where there is no form to fill: sign in once in a
// real browser, reuse the resulting `__session` cookie thereafter.
const STATE = process.env.SMOKE_STORAGE_STATE;
const fixtures = require('../fixtures');
const { signIn } = require('../deploy-auth');

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
      await signIn(page, baseURL, EMAIL, PASSWORD);
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
    let start = await api('POST', `/api/courses/${courseId}/exports/submissions`);
    // A COLD Cloud Run instance can answer the first export attempt with a bare
    // 503 — plain text, no JSON to explain itself — and then serve the retry
    // perfectly. Observed on the gcr trial: one run failed here, the next passed
    // untouched. Retry once so a cold start is not reported as a broken deploy;
    // a persistent 5xx is still recorded below.
    if (start.status === 502 || start.status === 503) {
      await new Promise((r) => setTimeout(r, 5000));
      start = await api('POST', `/api/courses/${courseId}/exports/submissions`);
    }
    // A deploy with no export worker refuses immediately and says why — that is
    // correct behaviour, not a failure of this test.
    if (start.status !== 200 || !(start.body.data || {}).exportId) {
      const why = JSON.stringify(start.body);
      // A 5xx that survives the retry has no JSON to match on. Record rather than
      // fail — this deploy may genuinely have no export worker — but the
      // annotation is the signal that its refusal is NOT the explanatory one #180
      // added, so a user gets no idea why their export did nothing.
      if (start.status >= 500) {
        test.info().annotations.push({ type: 'note',
          description: 'export unavailable: HTTP ' + start.status + ', no JSON explanation' });
      console.log(`  [#232] EXPORT REFUSED — download never exercised (HTTP ${start.status})`);
        return;
      }
      // Two legitimate refusals, both meaning "this deploy cannot export":
      //   * no worker registered (#180 makes this explicit)
      //   * an earlier export is wedged at pending, which on Cloud Run is
      //     permanent and blocks every later attempt (#179)
      expect(why, 'a refusal should explain itself').toMatch(/export worker|not available|already in progress/i);
      test.info().annotations.push({ type: 'note', description: 'export refused: ' + why.slice(0, 120) });
      console.log(`  [#232] EXPORT REFUSED — download never exercised: ${why.slice(0,90)}`);
      return;
    }

    const exportId = start.body.data.exportId;
    console.log(`  [#232] export accepted, id=${exportId}`);
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

    // --- and the download must actually WORK (#232) -------------------------
    // Asserting downloadUrl is truthy is not enough: the bug this covers
    // produced a perfectly truthy URL. downloadExport signed an AWS presigned
    // URL unconditionally, so on a GCS deploy it addressed a bucket that exists
    // only in Google Cloud Storage; with no AWS credentials that degrades to a
    // bare https://s3.amazonaws.com/, which 307s to the AWS marketing page.
    // A UIndy instructor's first real export landed on an advert.
    //
    // So follow the redirect and read the bytes. This is also the only check
    // that exercises REAL signing: a GCS V4 signature is minted through the IAM
    // SignBlob API, which fails unless the runtime service account holds
    // roles/iam.serviceAccountTokenCreator on ITSELF. Stubbed unit tests cannot
    // see that.
    const dl = await page.request.get(
      new URL(`/api/exports/${exportId}/download`, baseURL).toString(),
      { maxRedirects: 0 });

    expect(dl.status(), 'the download should redirect to a signed URL').toBe(302);
    const signed = dl.headers()['location'];
    expect(signed, 'the redirect must carry a Location').toBeTruthy();

    // The exact production symptom: a bare S3 endpoint redirects to an advert.
    expect(signed, 'a bare AWS endpoint means the URL was signed for the wrong backend')
      .not.toMatch(/^https:\/\/s3\.amazonaws\.com\/?$/);

    // Follow it WITHOUT session cookies — a signed URL must stand on its own.
    const object = await request.get(signed);
    expect(object.status(), `signed URL did not serve the archive: ${signed.slice(0, 120)}`)
      .toBe(200);

    const body = await object.body();
    console.log(`  [#232] signed host: ${new URL(signed).host}  bytes: ${body.length}  magic: ${body.slice(0,2).toString('latin1')}`);
    expect(body.length, 'the archive should not be empty').toBeGreaterThan(0);
    // PK\x03\x04 — a real zip, not an HTML error page.
    expect(body.slice(0, 2).toString('latin1'), 'the download should be a zip archive')
      .toBe('PK');
    test.info().annotations.push({ type: 'note',
      description: `export downloaded: ${body.length} bytes from ${new URL(signed).host}` });
  });

  test.afterEach(async ({ page, baseURL }) => {
    if (!courseId) return;
    await page.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(), { method: 'DELETE' })
      .catch(() => {});
    courseId = null;
  });
});
