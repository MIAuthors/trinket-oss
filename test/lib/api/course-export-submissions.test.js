const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const Export   = require('../../../lib/models/export');
const User     = require('../../../lib/models/user');
const queues   = require('../../../lib/util/queues');

// These tests exercise the ENQUEUE path, which now refuses to create an export
// on a server that has no worker to run it (the Cloud Run failure: jobs were
// queued into a handlerless queue and silently discarded). Register a no-op
// handler so the harness represents a deployment that can actually process.
// The refusal itself is covered in test/lib/util/queues.test.js.
beforeAll(() => {
  const q = queues.exports();
  if (typeof q.hasHandlers === 'function' && !q.hasHandlers()) q.process(() => {});
});

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

    it('should enqueue a course-submissions export and return the exportId', async () => {
      await flow.post('/api/courses/' + courseId + '/exports/submissions');

      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.success).toBe(true);
      expect(flow.lastResponse.body.data).toHaveProperty('exportId');
      expect(flow.lastResponse.body.data.status).toBe('pending');

      const exportRecord = await Export.findById(flow.lastResponse.body.data.exportId);
      expect(exportRecord).toBeTruthy();
      expect(exportRecord.type).toBe('course-submissions');
      expect(exportRecord.courseId.toString()).toBe(courseId);
    });

    it('should enqueue an assignment-submissions export and return the exportId', async () => {
      await flow.post('/api/courses/' + courseId + '/materials/' + materialId + '/exports/submissions');

      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.success).toBe(true);
      expect(flow.lastResponse.body.data).toHaveProperty('exportId');
      expect(flow.lastResponse.body.data.status).toBe('pending');

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
