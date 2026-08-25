// LTI 1.1 end-to-end against the real route: a signed basic-lti-launch on
// /lti/launch must provision the user, enroll them in the custom-param
// course, and 302 to it. Signature-level rules live in unit tests
// (lti11-verify.test.js); this proves the wiring Todd/Drew's "tested it all"
// condition asks for.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const User     = require('../../../lib/models/user');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

beforeEach(() => { flow.cookies = {}; });

// Sign against the URL the SERVER will reconstruct for an injected request:
// same function, same inputs (inject with an absolute URL pins the host
// header), so the strings match by construction.
const AUTHORITY = 'localhost';
function serverLaunchUrl() {
  return v.launchUrlFromRequest(
    { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path: '/lti/launch' },
    config.app.url, publicHostname.resolve);
}

function signedLaunch(consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-test-1',
    user_id: 'wiley-user-1',
    roles: 'Learner',
    lis_person_contact_email_primary: 'lti11student@example.com',
    lis_person_name_full: 'Lti Eleven',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'n-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverLaunchUrl(), p, consumer.secret);
  return p;
}

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'test-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'test' });
  await c.save();
  return c;
}

describe('LTI 1.1 launch (integration)', () => {
  it('provisions, enrolls, and lands a student in the custom-param course', async () => {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Lti11 Course' });
    const course = flow.lastResponse.body.course;
    const consumer = await seedConsumer();

    const params = signedLaunch(consumer, { custom_trinket_course: course.id });
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti/launch', params);

    expect(flow.lastResponse.statusCode, JSON.stringify(flow.lastResponse.body).slice(0, 200)).toBe(302);
    expect(flow.lastResponse.headers.location).toContain('/courses/' + course.slug);

    const user = await User.findByLogin('lti11student@example.com');
    expect(user, 'user should be auto-provisioned').toBeTruthy();
    const ctx = user.getByContext('course:' + course.id);
    expect(ctx && ctx.roles && ctx.roles[0], 'enrolled as student').toBe('course-student');
  });

  // Rejections surface as a redirect to /login: this is an html route, and
  // routeParser turns auth Booms into the browser-appropriate redirect. The
  // assertions therefore check "NOT let in" = login redirect, never a course.
  function expectRejected() {
    expect(flow.lastResponse.statusCode).toBe(302);
    expect(flow.lastResponse.headers.location).toContain('/login');
  }

  it('rejects a launch signed with the wrong secret', async () => {
    const consumer = await seedConsumer();
    const params = signedLaunch({ key: consumer.key, secret: 'not-the-secret' }, {});
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti/launch', params);
    expectRejected();
  });

  it('rejects a replayed launch (same nonce twice)', async () => {
    const consumer = await seedConsumer();
    const params = signedLaunch(consumer, {});
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti/launch', params);
    const first = flow.lastResponse.statusCode;
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti/launch', params);
    expect(first).toBe(302);
    expectRejected();
  });

  it('rejects an unknown consumer key', async () => {
    const params = signedLaunch({ key: 'nope', secret: 'x' }, {});
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti/launch', params);
    expectRejected();
  });

  it('serves a config XML that pre-fills launch URL, privacy, and the course custom field', async () => {
    await flow.get('/lti11/config.xml?course=abcDEF123');
    const xml = flow.lastResponse.body;
    const text = typeof xml === 'string' ? xml : JSON.stringify(xml);
    expect(text).toContain('/lti/launch');
    expect(text).toContain('privacy_level');
    expect(text).toContain('trinket_course');
    expect(text).toContain('abcDEF123');
  });

  it('refuses a malformed course id in the config XML', async () => {
    await flow.get('/lti11/config.xml?course=<script>');
    expect(flow.lastResponse.statusCode).toBe(400);
  });
});
