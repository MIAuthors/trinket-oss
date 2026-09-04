// Per-placement targeting via the launch URL: /lti11/launch?assignment=<materialId>.
//
// A custom field on the tool config is TOOL-WIDE — every assignment using that tool
// would resolve to the same material. Canvas stores the External Tool URL per
// assignment, so the URL is the per-placement statement.
//
// This also covers a latent defect: OAuth 1.0a folds query params into the signature
// base, and lti11Verify documents that the caller merges them, but the caller passed
// only the POST body — so ANY launch URL with a query string failed to verify.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const ltiTarget = require('../../../lib/util/ltiTarget');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
const AUTHORITY = 'localhost';
const PATH = '/lti11/launch';
const serverUrl = () => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path: PATH },
  config.app.url, publicHostname.resolve);

function baseParams(consumer, extra) {
  return Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-url-1',
    user_id: 'student-url-1',
    roles: 'Learner',
    lis_person_contact_email_primary: 'urltarget@example.com',
    lis_person_name_full: 'Url Target',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'u-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
}

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'u-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'url target' });
  await c.save();
  return c;
}

describe('LTI 1.1 launch-URL targeting', () => {
  let seenClaims;
  beforeEach(() => {
    flow.cookies = {};
    seenClaims = [];
    // Capture what the target resolver is asked for, without needing real course data.
    vi.spyOn(ltiTarget, 'resolveTarget').mockImplementation((claims) => {
      seenClaims.push(claims); return Promise.resolve({ course: null });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes ?assignment= through as the trinket_assignment custom param', async () => {
    const consumer = await seedConsumer();
    const query = { assignment: 'material-123' };
    const body = baseParams(consumer);
    // Canvas signs body + query together.
    body.oauth_signature = v.sign('POST', serverUrl(), Object.assign({}, query, body), consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH + '?assignment=material-123', body);

    expect(flow.lastResponse.statusCode).toBe(302);
    expect(seenClaims.length, 'the launch must reach target resolution').toBe(1);
    expect(seenClaims[0][LTI + 'custom'].trinket_assignment).toBe('material-123');
  });

  it('rejects a launch whose signature omitted the query param', async () => {
    const consumer = await seedConsumer();
    const body = baseParams(consumer);
    // Signed over the body ALONE — what a broken platform (or a tamperer appending
    // ?assignment=) would send. If this were accepted, the query would be unsigned.
    body.oauth_signature = v.sign('POST', serverUrl(), body, consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH + '?assignment=material-123', body);

    expect(flow.lastResponse.headers.location || '').toContain('/login');
    expect(seenClaims.length, 'must not reach target resolution').toBe(0);
  });

  it('still accepts a plain launch with no query string', async () => {
    const consumer = await seedConsumer();
    const body = baseParams(consumer);
    body.oauth_signature = v.sign('POST', serverUrl(), body, consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH, body);

    expect(flow.lastResponse.statusCode).toBe(302);
    expect(seenClaims[0][LTI + 'custom'].trinket_assignment).toBeUndefined();
  });

  it('ignores a malformed id rather than failing the launch', async () => {
    const consumer = await seedConsumer();
    const query = { assignment: '../../etc/passwd' };
    const body = baseParams(consumer);
    body.oauth_signature = v.sign('POST', serverUrl(), Object.assign({}, query, body), consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH + '?assignment=' + encodeURIComponent(query.assignment), body);

    expect(flow.lastResponse.statusCode).toBe(302);
    expect(seenClaims[0][LTI + 'custom'].trinket_assignment).toBeUndefined();
  });

  it('lets the per-placement URL win over a tool-wide custom field', async () => {
    const consumer = await seedConsumer();
    const query = { assignment: 'material-url' };
    const body = baseParams(consumer, { custom_trinket_assignment: 'material-toolwide' });
    body.oauth_signature = v.sign('POST', serverUrl(), Object.assign({}, query, body), consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH + '?assignment=material-url', body);

    expect(seenClaims[0][LTI + 'custom'].trinket_assignment).toBe('material-url');
  });
});
