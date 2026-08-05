const flow   = require('../../helpers/flow.cjs');
const config = require('config');

let prev;
beforeEach(() => { flow.cookies = {}; prev = config.features.accessCodeEnrollment; });
afterEach(()  => { config.features.accessCodeEnrollment = prev; });

describe('Access-code enrollment gate', () => {
  async function makeCourse() {
    await flow.switchUser('user');
    await flow.createCourse();
    return flow.lastResponse.body.course.id;
  }

  describe('when features.accessCodeEnrollment is OFF', () => {
    beforeEach(() => { config.features.accessCodeEnrollment = false; });

    it('POST generateAccessCode is 404', async () => {
      const courseId = await makeCourse();
      await flow.post('/api/courses/' + courseId + '/accessCode', {});
      expect(flow.lastResponse.statusCode).toBe(404);
    });
    it('GET accessCode is 404', async () => {
      const courseId = await makeCourse();
      await flow.get('/api/courses/' + courseId + '/accessCode');
      expect(flow.lastResponse.statusCode).toBe(404);
    });
    it('POST /courses/join is 404', async () => {
      await flow.switchUser('user2');
      await flow.post('/api/courses/join', { accessCode: 'ABC123' });
      expect(flow.lastResponse.statusCode).toBe(404);
    });
  });

  describe('when features.accessCodeEnrollment is ON', () => {
    beforeEach(() => { config.features.accessCodeEnrollment = true; });

    it('an owner can generate a code and a second user can join with it', async () => {
      const courseId = await makeCourse();
      await flow.post('/api/courses/' + courseId + '/accessCode', {});
      expect(flow.lastResponse.statusCode).toBe(200);
      const code = flow.lastResponse.body.accessCode;
      expect(code).toBeTruthy();

      await flow.switchUser('user2');
      await flow.post('/api/courses/join', { accessCode: code });
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.body.success).toBe(true);
      expect(flow.lastResponse.body.course.id).toBe(courseId);
    });
  });
});
