const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const Export   = require('../../../lib/models/export');
const User     = require('../../../lib/models/user');
const queues   = require('../../../lib/util/queues');

// These endpoints no longer enqueue: they build the archive INSIDE the request
// (see lib/controllers/course.js). The queue could not deliver on Cloud Run —
// no worker registers there, so jobs were discarded and the record sat
// 'pending' while the UI polled it forever.
//
// The archive builder itself is covered by
// test/lib/workers/processStudentWorkExport.test.js (which stubs S3). Here we
// stub the runner so these tests stay about the ENDPOINT contract — status,
// record shape, permissions — rather than re-testing archive construction.
// The controller does a lazy `require('../workers/exports')` at call time, so
// replacing the property on the shared module object is what actually takes
// effect here — vi.mock does not reliably intercept CommonJS require().
// Required lazily inside beforeAll, never at module top: a top-level require
// runs at test-file load, before the harness's config fixups, and blows up in
// @hapi/validate ("Schema can only contain plain objects"). Same reason
// processStudentWorkExport.test.js defers its own require.
let workers, realRunner;
beforeAll(() => {
  workers = require('../../../lib/workers/exports');
  realRunner = workers.processStudentWorkExport;
  workers.processStudentWorkExport = async (job) => {
    const rec = await Export.findById(job.data.exportId);
    rec.status = 'completed';
    await rec.save();
    return rec;
  };
});
afterAll(() => { workers.processStudentWorkExport = realRunner; });

// Reset the cookie jar before every test.
beforeEach(() => {
  flow.cookies = {};
});

describe('Course/Assignment student-work export endpoints', () => {
  describe('As the course owner (instructor)', () => {
    let course, courseId, lessonId, materialId;

    beforeEach(async () => {
      await flow.switchUser('user');
      await flow.createCourse();
      courseId = flow.lastResponse.body.course.id;
      await flow.addNewLesson(courseId);
      lessonId = flow.lastResponse.body.data.id;
      await flow.addNewMaterial(courseId, lessonId);
      materialId = flow.lastResponse.body.data.id;
    });

    it('builds a course-submissions export in-request and returns it completed', async () => {
      await flow.post('/api/courses/' + courseId + '/exports/submissions');

      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.success).toBe(true);
      expect(flow.lastResponse.body.data).toHaveProperty('exportId');
      // 'completed', not 'pending': the work happened during this request.
      expect(flow.lastResponse.body.data.status).toBe('completed');

      const exportRecord = await Export.findById(flow.lastResponse.body.data.exportId);
      expect(exportRecord).toBeTruthy();
      expect(exportRecord.type).toBe('course-submissions');
      expect(exportRecord.courseId.toString()).toBe(courseId);
    });

    it('works on a server with no export worker at all', async () => {
      // The exact Cloud Run shape that used to spin forever: no handler
      // registered anywhere. These endpoints must not care — they no longer
      // enqueue. (The account bulk export still does, and still refuses; that
      // path is covered by exportGuard's own tests.)
      const q = queues.exports();
      const saved = q.handlers;
      q.handlers = [];
      try {
        await flow.post('/api/courses/' + courseId + '/exports/submissions');
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.body.data.status).toBe('completed');
      } finally {
        q.handlers = saved;
      }
    });

    it('builds an assignment-submissions export in-request and returns it completed', async () => {
      await flow.post('/api/courses/' + courseId + '/materials/' + materialId + '/exports/submissions');

      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.success).toBe(true);
      expect(flow.lastResponse.body.data).toHaveProperty('exportId');
      // 'completed', not 'pending': the work happened during this request.
      expect(flow.lastResponse.body.data.status).toBe('completed');

      const exportRecord = await Export.findById(flow.lastResponse.body.data.exportId);
      expect(exportRecord).toBeTruthy();
      expect(exportRecord.type).toBe('assignment-submissions');
      expect(exportRecord.courseId.toString()).toBe(courseId);
      expect(exportRecord.materialId.toString()).toBe(materialId);
    });

  });

  describe('As an instructor with an export already in flight', () => {
    // Use a distinct owner (admin) + course from the other blocks above, so
    // this test isn't racing the in-memory queue's async processing of
    // exports created by earlier tests for the same user.
    let courseId, inFlight;

    beforeEach(async () => {
      await flow.switchUser('admin');
      await flow.createCourse();
      courseId = flow.lastResponse.body.course.id;

      const owner = await new Promise((resolve, reject) => {
        User.findByLogin(defaults.admin.email, (err, doc) => err ? reject(err) : resolve(doc));
      });

      inFlight = await new Export({
        _owner: owner.id,
        type: 'course-submissions',
        courseId: courseId,
        status: 'processing'
      }).save();
    });

    it('should reject a new export request with the in-flight exportId', async () => {
      await flow.post('/api/courses/' + courseId + '/exports/submissions');

      // request.fail() replies 200 with an {error, ...} body (same
      // soft-failure convention as users.js#requestExport) rather than a
      // distinct HTTP error status.
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.error).toBe('Export already in progress');
      expect(flow.lastResponse.body.exportId).toBe(inFlight._id.toString());
    });
  });

  describe('As a logged-in user who is not a member of the course', () => {
    let courseId, materialId;

    beforeEach(async () => {
      await flow.switchUser('user');
      await flow.createCourse();
      courseId = flow.lastResponse.body.course.id;
      await flow.addNewLesson(courseId);
      const lessonId = flow.lastResponse.body.data.id;
      await flow.addNewMaterial(courseId, lessonId);
      materialId = flow.lastResponse.body.data.id;

      // admin is a distinct, real account but has no role on this course
      await flow.switchUser('admin');
    });

    it('should 403 on the course export endpoint', async () => {
      await flow.post('/api/courses/' + courseId + '/exports/submissions');
      expect(flow.lastResponse.statusCode).toBe(403);
    });

    it('should 403 on the assignment export endpoint', async () => {
      await flow.post('/api/courses/' + courseId + '/materials/' + materialId + '/exports/submissions');
      expect(flow.lastResponse.statusCode).toBe(403);
    });
  });
});
