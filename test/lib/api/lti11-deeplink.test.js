// LTI 1.1 deep linking (Content-Item Message), end to end.
//
// The picker UI and the instructor's choice are identical to 1.3; only the entry
// point and the response format differ, so both share /lti/deep-link. This proves
// the 1.1 entry establishes a session and reaches the same picker, and that the
// selection comes back as an OAuth-signed content-item form.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const defaults = require('../../helpers/defaults');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

const AUTHORITY = 'localhost';
const PATH = '/lti11/launch';
const RETURN = 'https://canvas.example/courses/1/external_content/success/external_tool_dialog';
const serverUrl = () => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path: PATH },
  config.app.url, publicHostname.resolve);

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'dl-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'deep link test' });
  await c.save();
  return c;
}

function contentItemLaunch(consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'ContentItemSelectionRequest',
    lti_version: 'LTI-1p0',
    user_id: 'instructor-dl-1',
    roles: 'Instructor',
    lis_person_contact_email_primary: defaults.user.email,
    lis_person_name_full: 'Test User',
    content_item_return_url: RETURN,
    accept_multiple: 'false',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'dl-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverUrl(), p, consumer.secret);
  return p;
}

describe('LTI 1.1 deep linking', () => {
  beforeEach(() => { flow.cookies = {}; });

  it('sends a ContentItemSelectionRequest to the shared picker', async () => {
    const consumer = await seedConsumer();
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, contentItemLaunch(consumer));
    expect(flow.lastResponse.statusCode,
      JSON.stringify(flow.lastResponse.body).slice(0, 200)).toBe(302);
    expect(flow.lastResponse.headers.location).toBe('/lti/deep-link');
  });

  it('refuses a content-item request with nowhere to return to', async () => {
    const consumer = await seedConsumer();
    const p = contentItemLaunch(consumer, { content_item_return_url: '' });
    p.oauth_signature = v.sign('POST', serverUrl(), p, consumer.secret);
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, p);
    expect(flow.lastResponse.headers.location || '').not.toBe('/lti/deep-link');
  });

  it('still rejects an unsigned content-item request', async () => {
    const consumer = await seedConsumer();
    const p = contentItemLaunch({ key: consumer.key, secret: 'wrong-secret' });
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, p);
    expect(flow.lastResponse.headers.location || '').toContain('/login');
  });

  it('returns the selection as an OAuth-signed content-item form', async () => {
    // Own a course so the picker has something real to offer.
    await flow.switchUser('user');
    await flow.createCourse({ name: 'DL Course ' + Math.random().toString(36).slice(2, 6) });
    const course = flow.lastResponse.body.course;
    flow.cookies = {};

    const consumer = await seedConsumer();
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, contentItemLaunch(consumer));
    expect(flow.lastResponse.headers.location).toBe('/lti/deep-link');

    // The session established by the launch carries the deep-link context.
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti/deep-link/select', {
      targetType: 'assignment', courseId: course.id, targetId: 'material-1', title: 'HW 1'
    });

    const html = String(flow.lastResponse.body || flow.lastResponse.payload || '');
    expect(html, 'should render the auto-posting return form').toContain(RETURN);
    expect(html).toContain('content_items');
    expect(html).toContain('oauth_signature');
    expect(html).toContain('ContentItemSelection');
    // The targeting the whole feature exists to deliver.
    expect(html).toContain('trinket_assignment');
  });
});

describe('LTI 1.1 config XML', () => {
  it('declares the deep-linking placements, or Canvas offers no picker', async () => {
    await flow.get('/lti11/config.xml');
    const xml = String(flow.lastResponse.body);
    expect(xml).toContain('resource_selection');
    expect(xml).toContain('assignment_selection');
    expect(xml).toContain('/lti11/launch');
  });
});
