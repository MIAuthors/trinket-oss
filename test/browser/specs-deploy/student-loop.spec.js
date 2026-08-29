const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signInWithForm, apiFor, unwrap, assertOk } = require('../deploy-auth');

// The loop that actually matters to a class, end to end, with TWO real accounts:
//
//   instructor  builds a course + assignment, puts the student on the roster
//   student     signs in, finds the course, opens the assignment, submits
//   instructor  reads the submission and sends feedback
//   student     sees that feedback
//
// Every previous deploy test stopped at "the instructor can create things".
// Nothing checked that a student could then DO anything, which is the half that
// carries the permission boundaries: a course owner can do everything, so
// submitting as the owner would prove nothing.
//
// Needs the second standing identity:
//   SMOKE_EMAIL/SMOKE_PASSWORD and SMOKE_STUDENT_EMAIL/SMOKE_STUDENT_PASSWORD

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const S_EMAIL = process.env.SMOKE_STUDENT_EMAIL;
const S_PASSWORD = process.env.SMOKE_STUDENT_PASSWORD;

test.describe('student loop', () => {
  test.skip(!(EMAIL && PASSWORD && S_EMAIL && S_PASSWORD),
    'needs both standing identities: SMOKE_EMAIL/PASSWORD + SMOKE_STUDENT_EMAIL/PASSWORD');

  let courseId = null;

  test('student submits, instructor responds, student sees the response',
    async ({ browser, baseURL }) => {
    const runId = fixtures.runId();

    const teacherCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const teacher = await teacherCtx.newPage();
    const student = await studentCtx.newPage();
    const tApi = apiFor(teacher, baseURL);
    const sApi = apiFor(student, baseURL);

    try {
      await signInWithForm(teacher, baseURL, EMAIL, PASSWORD);

      // --- instructor sets up -------------------------------------------------
      const created = await tApi('POST', '/api/courses',
        { name: fixtures.courseName(runId), description: 'student loop' });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      courseId = unwrap(created.body, 'course').id;

      const lessonRes = await tApi('POST', `/api/courses/${courseId}/lessons`, { name: 'Week 1' });
      const lessonId = (unwrap(lessonRes.body, 'lesson') || {}).id;
      expect(lessonId).toBeTruthy();

      const asgRes = await tApi('POST', `/api/courses/${courseId}/lessons/${lessonId}/materials`,
        { name: 'Assignment 1', type: 'assignment', trinketId: '_blank_', lang: 'python3',
          submissionsDueEnabled: false, submissionsCutoffEnabled: false,
          availableOnEnabled: false, hideAfterEnabled: false });
      expect(asgRes.status, JSON.stringify(asgRes.body)).toBe(200);
      const assignment = unwrap(asgRes.body, 'material');
      const materialId = assignment.id;
      const promptTrinket = assignment.trinket && assignment.trinket.trinketId;
      expect(promptTrinket, 'assignment needs its prompt trinket to submit against').toBeTruthy();

      // Roster the REAL second account, by the same route the paste UI uses.
      const invited = await tApi('POST', `/api/courses/${courseId}/invitations`, {
        students: [{ email: S_EMAIL, name: 'Smoke Learner', line: 'Smoke, Learner, ' + S_EMAIL }],
      });
      assertOk(expect, invited, 'inviting the student');

      // --- student arrives ----------------------------------------------------
      // Signing in is also what enrols an ALREADY-EXISTING invited user (#10):
      // the invitation alone does not enrol them, the next login does.
      await signInWithForm(student, baseURL, S_EMAIL, S_PASSWORD);

      const mine = await sApi('GET', '/api/courses');
      const list = (mine.body && (mine.body.data || mine.body.courses)) || [];
      expect(list.some((c) => c.id === courseId),
        'an invited student who has now signed in should see the course (#10)').toBe(true);

      // --- student submits ----------------------------------------------------
      const submitted = await sApi('POST',
        `/api/courses/${courseId}/lessons/${lessonId}/materials/${materialId}/submissions`,
        { code: { files: {} }, comments: 'my attempt', parent: promptTrinket });
      assertOk(expect, submitted, 'a rostered student must be able to submit');
      const submission = unwrap(submitted.body, 'submission');
      expect(submission && submission.id).toBeTruthy();

      // --- instructor sees it and responds ------------------------------------
      const seen = await tApi('GET',
        `/api/courses/${courseId}/lessons/${lessonId}/materials/${materialId}/submissions`);
      assertOk(expect, seen, "instructor reads the material's submissions");

      // This list is keyed by USER, one row each, and the row carries the
      // submission's trinketId — which is what feedback is addressed to. The
      // submission-create response does not include it, and posting an empty
      // trinketId is answered 200-with-a-validation-flash, so getting this wrong
      // looks exactly like success.
      const rows = (seen.body && (seen.body.data || seen.body.submissions)) || [];
      const studentRow = rows.find((r) => r.email === S_EMAIL && r.trinketId);
      expect(studentRow,
        "the student's submission must appear in the instructor's list").toBeTruthy();

      const feedback = await tApi('POST',
        `/api/courses/${courseId}/lessons/${lessonId}/materials/${materialId}/feedback`,
        { code: { files: {} }, trinketId: studentRow.trinketId,
          comments: 'nice work — ' + runId, includeRevision: false, allowResubmit: true });
      assertOk(expect, feedback, 'instructor sends feedback');

      // --- and the student can actually read it -------------------------------
      // The point of the whole loop. Feedback that the instructor can see and
      // the student cannot is indistinguishable, to the student, from no
      // feedback at all.
      // GET /api/submissions/{materialId} is the STUDENT-facing read: it scopes to
      // the caller, so it is what the student's own assignment page uses.
      const back = await sApi('GET', `/api/submissions/${materialId}`);
      assertOk(expect, back, 'student reads their own submissions');
      expect(JSON.stringify(back.body).includes(runId),
        'the student should be able to read the feedback left for them').toBe(true);
    } finally {
      if (courseId) {
        await teacher.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(),
          { method: 'DELETE' }).catch(() => {});
        courseId = null;
      }
      await teacherCtx.close();
      await studentCtx.close();
    }
  });
});
