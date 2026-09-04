// Capturing LTI 1.1 Basic Outcomes coordinates at launch.
//
// Without lis_result_sourcedid + lis_outcome_service_url there is no way to tell a
// 1.1 platform that a submission exists — 1.1 has no AGS, so the outcomes service
// is the only channel. The launch handler used to discard both. See #203.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const defaults = require('../../helpers/defaults');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const LtiOutcome  = require('../../../lib/models/ltiOutcome');
const User     = require('../../../lib/models/user');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

const AUTHORITY = 'localhost';
const LAUNCH = '/lti11/launch';
const serverUrl = (path) => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path },
  config.app.url, publicHostname.resolve);

function signedLaunch(consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-outcomes-1',
    user_id: 'student-outcomes-1',
    roles: 'Learner',
    lis_person_contact_email_primary: 'outcomes-student@example.com',
    lis_person_name_full: 'Outcomes Student',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'oc-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverUrl(LAUNCH), p, consumer.secret);
  return p;
}

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'oc-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'outcomes test' });
  await c.save();
  return c;
}

// Capture is deliberately fire-and-forget so gradebook bookkeeping can never fail a
// student's launch — which means the 302 can beat the write. Poll rather than race.
async function waitForOutcome(platformId, linkId, userId) {
  for (let i = 0; i < 40; i++) {
    const rec = await LtiOutcome.findForPlacement(platformId, linkId, userId);
    if (rec) return rec;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

describe('LTI 1.1 outcomes capture', () => {
  beforeEach(() => { flow.cookies = {}; });

  async function launchInto(extra) {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Outcomes Course ' + Math.random().toString(36).slice(2, 7) });
    const course = flow.lastResponse.body.course;
    const consumer = await seedConsumer();
    flow.cookies = {};
    const params = signedLaunch(consumer, Object.assign({ custom_trinket_course: course.id }, extra || {}));
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, params);
    expect(flow.lastResponse.statusCode).toBe(302);
    const user = await User.findByLogin('outcomes-student@example.com');
    return { consumer, course, user, params };
  }

  it('stores sourcedid + service url from a graded launch', async () => {
    const { consumer, user } = await launchInto({
      lis_result_sourcedid: 'sourced-abc-123',
      lis_outcome_service_url: 'https://lms.example/outcomes'
    });

    const rec = await waitForOutcome('lti11:' + consumer.key, 'rl-outcomes-1', String(user.id));
    expect(rec, 'outcome coordinates should be captured').toBeTruthy();
    expect(rec.sourcedId).toBe('sourced-abc-123');
    expect(rec.serviceUrl).toBe('https://lms.example/outcomes');
  });

  it('stores nothing for an ungraded launch that carries neither field', async () => {
    const { consumer, user } = await launchInto({});
    // Give a stray write the same chance to appear as a real one would have.
    const rec = await waitForOutcome('lti11:' + consumer.key, 'rl-outcomes-1', String(user.id));
    expect(rec).toBeFalsy();
  });

  it('refreshes a reissued sourcedid rather than keeping the stale one', async () => {
    const { consumer, user, course } = await launchInto({
      lis_result_sourcedid: 'sourced-old',
      lis_outcome_service_url: 'https://lms.example/outcomes'
    });
    expect(await waitForOutcome('lti11:' + consumer.key, 'rl-outcomes-1', String(user.id))).toBeTruthy();

    // Same student, same placement, new sourcedid — what an LMS does when the
    // assignment is re-created. A write-once capture would keep the dead value.
    flow.cookies = {};
    const again = signedLaunch(consumer, {
      custom_trinket_course: course.id,
      lis_result_sourcedid: 'sourced-new',
      lis_outcome_service_url: 'https://lms.example/outcomes2'
    });
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, again);
    expect(flow.lastResponse.statusCode).toBe(302);

    for (let i = 0; i < 40; i++) {
      const r = await LtiOutcome.findForPlacement('lti11:' + consumer.key, 'rl-outcomes-1', String(user.id));
      if (r && r.sourcedId === 'sourced-new') { expect(r.serviceUrl).toBe('https://lms.example/outcomes2'); return; }
      await new Promise(r2 => setTimeout(r2, 25));
    }
    throw new Error('sourcedid was not refreshed on re-launch');
  });
});
