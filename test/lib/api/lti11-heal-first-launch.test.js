'use strict';
// The FIRST launch of a graded placement nobody has opened before.
//
// lti11-heal-on-launch.test.js pre-seeds the LtiResourceLink, so it only ever
// covers a placement that has already been launched. But the row is created by
// ltiTarget.resolveTarget (ltiTarget.js, the "bootstrap" path) on the first
// launch — and notifyOnCoordinates runs BEFORE that, off LtiOutcome.record.
// So on a placement's very first launch findByLink has nothing to find and the
// existing submission is not reported, even though the coordinates just
// arrived. The student has to launch a second time.
//
// This is the live shape: a student works through the course UI, the
// instructor deep-links that material as a graded assignment afterwards, and
// the student opens it for the first time.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const LtiConsumer     = require('../../../lib/models/ltiConsumer');
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');
const Trinket         = require('../../../lib/models/trinket');
const User            = require('../../../lib/models/user');
const lti11Outcomes   = require('../../../lib/util/lti11Outcomes');
const v               = require('../../../lib/util/lti11Verify');
const publicHostname  = require('../../../lib/util/publicHostname');

const AUTHORITY = 'localhost';
const LAUNCH = '/lti11/launch';
const RL = 'rl-first-assignment';
const RL_COURSE = 'rl-first-course';
const STUDENT = 'student-first-1';
const EMAIL = 'first-launch-student@example.com';

const serverUrl = (path) => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path },
  config.app.url, publicHostname.resolve);

function signedLaunch(consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: RL,
    user_id: STUDENT,
    roles: 'Learner',
    lis_person_contact_email_primary: EMAIL,
    lis_person_name_full: 'First Launch Student',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'fl-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverUrl(LAUNCH), p, consumer.secret);
  return p;
}

const hexId = () => Array.from({ length: 24 },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function waitForPost(posted, n) {
  for (let i = 0; i < 80; i++) {
    if (posted.length >= n) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

describe('LTI 1.1: the first launch of a never-opened graded placement', () => {
  let posted;

  beforeEach(() => {
    flow.cookies = {};
    posted = [];
    vi.spyOn(lti11Outcomes, 'postSubmission').mockImplementation((a) => {
      posted.push(a); return Promise.resolve({ ok: true });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports the existing submission on the FIRST launch, not the second', async () => {
    const consumer = new LtiConsumer({
      key: 'fl-' + Math.random().toString(36).slice(2, 10),
      secret: 'shhh-' + Math.random().toString(36).slice(2),
      name: 'first launch test'
    });
    await consumer.save();

    await flow.switchUser('user');
    await flow.createCourse({ name: 'First Launch Course ' + Math.random().toString(36).slice(2, 7) });
    const course = flow.lastResponse.body.course;
    flow.cookies = {};

    // The student enters through the ungraded course link and is provisioned.
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH,
      signedLaunch(consumer, { resource_link_id: RL_COURSE, custom_trinket_course: course.id }));
    expect(flow.lastResponse.statusCode).toBe(302);
    const student = await User.findByLogin(EMAIL);
    expect(student, 'the course-link launch should provision the student').toBeTruthy();

    // They submit through trinket's own UI. No coordinates exist, so nothing
    // is reportable yet.
    const materialId = hexId();
    const submission = new Trinket({
      name: 'First Launch Submission', lang: 'python3',
      _creator: String(student.id), _owner: String(student.id),
      courseId: String(course.id), materialId: materialId,
      submittedOn: new Date()
    });
    await submission.save();
    expect(posted.length, 'nothing reportable before coordinates exist').toBe(0);

    // Deliberately NO LtiResourceLink seeded: this placement has never been
    // launched. custom_trinket_assignment is what the instructor's deep link
    // carries, and is what resolveTarget bootstraps the row from.
    const existing = await LtiResourceLink.findAssignmentLink(String(course.id), materialId);
    expect(existing, 'precondition: the placement has never been launched').toBeFalsy();

    // The student opens the graded assignment for the first time. The
    // coordinates arrive on THIS launch.
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      custom_trinket_course: course.id,
      custom_trinket_assignment: materialId,
      lis_result_sourcedid: 'sourced-first-launch',
      lis_outcome_service_url: 'https://lms.example/outcomes'
    }));
    expect(flow.lastResponse.statusCode).toBe(302);

    expect(await waitForPost(posted, 1),
      'the submission should be reported on the FIRST launch of the placement').toBe(true);
    expect(posted[0].sourcedId).toBe('sourced-first-launch');
    expect(posted[0].launchUrl).toBe(config.url + '/lti11/launch?submission=' + submission.id);
  });
});
