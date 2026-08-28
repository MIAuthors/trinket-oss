// LTI 1.3 SpeedGrader review, end to end through the real route.
//
// This path shipped in f03b237 and had no end-to-end coverage, which is how a
// misreading of it survived into #203: the review URL arrives as the
// target_link_uri CLAIM and is never fetched as a path, so grepping the route
// table for /lti/review finds nothing and looks like a bug.
//
// Only the JWT signature check is stubbed (ltiVerify.verifyLaunchToken) — its
// crypto is covered separately. state, nonce, deployment, message-type, replay
// and the review branch all run for real.
const flow      = require('../../helpers/flow.cjs');
const config    = require('config');
const defaults  = require('../../helpers/defaults');
const ltiState  = require('../../../lib/util/ltiState');
const ltiVerify = require('../../../lib/util/ltiVerify');
const LtiPlatform = require('../../../lib/models/ltiPlatform');
const Trinket   = require('../../../lib/models/trinket');

const crypto = require('crypto');

// ltiState signs the `state` token with the Tool key, and it has to survive a form
// POST as a string — so give it a real ephemeral key rather than stubbing the
// signer. ltiKeys reads LTI_PRIVATE_KEY at first use and caches only a key that
// exists, so setting it here is enough.
let hadKey;
beforeAll(() => {
  hadKey = process.env.LTI_PRIVATE_KEY;
  if (!hadKey) {
    process.env.LTI_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' }
    }).privateKey;
  }
});
afterAll(() => { if (!hadKey) delete process.env.LTI_PRIVATE_KEY; });

const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
const ISS = 'https://canvas.test';
const CID = 'client-abc';
const DEP = 'deployment-1';

describe('LTI 1.3 review launch (SpeedGrader)', () => {
  beforeEach(() => { flow.cookies = {}; });
  afterEach(() => { vi.restoreAllMocks(); });

  async function seedPlatform() {
    const p = new LtiPlatform({
      issuer: ISS, clientId: CID,
      authLoginUrl: ISS + '/api/lti/authorize_redirect',
      jwksUrl: ISS + '/api/lti/security/jwks',
      deploymentIds: [DEP], status: 'active', trustEmail: true,
      name: 'Test Canvas', productFamily: 'canvas'
    });
    await p.save();
    return p;
  }

  async function ownedCourse() {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Review 13 ' + Math.random().toString(36).slice(2, 7) });
    const c = flow.lastResponse.body.course;
    flow.cookies = {};
    return c;
  }

  // A SpeedGrader review launch: the grader's identity, and the review URL in
  // target_link_uri. Deliberately NO resource_link custom params — that absence is
  // exactly why the handler must authorize against the submission's own course.
  async function reviewLaunch(reviewPath, email) {
    const nonce = 'n-' + Math.random().toString(36).slice(2);
    const state = ltiState.sign({ nonce, iss: ISS, clientId: CID, target: config.url + reviewPath });
    const claims = {
      iss: ISS, sub: 'grader-sub-1', nonce,
      email: email, name: 'Test User'
    };
    claims[LTI + 'deployment_id']  = DEP;
    claims[LTI + 'message_type']   = 'LtiResourceLinkRequest';
    claims[LTI + 'version']        = '1.3.0';
    claims[LTI + 'roles']          = ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'];
    claims[LTI + 'custom']         = {};
    claims[LTI + 'resource_link']  = { id: 'rl-review' };
    claims[LTI + 'target_link_uri'] = config.url + reviewPath;
    vi.spyOn(ltiVerify, 'verifyLaunchToken').mockImplementation(() => Promise.resolve(claims));
    await flow._inject('POST', 'http://localhost/lti/launch', { state, id_token: 'stub.jwt.token' });
  }

  it('renders the submission for an authorized grader', async () => {
    const course = await ownedCourse();
    await seedPlatform();
    vi.spyOn(Trinket, 'findById').mockImplementation(() => Promise.resolve(
      { id: 'sub-13', lang: 'python3', courseId: course.id }));

    await reviewLaunch('/lti/review/sub-13', defaults.user.email);

    expect(flow.lastResponse.statusCode,
      JSON.stringify(flow.lastResponse.body).slice(0, 300)).toBe(302);
    expect(flow.lastResponse.headers.location).toBe('/lti/review-panel/sub-13');
  });

  it('refuses a launcher with no feedback permission on the submission course', async () => {
    await ownedCourse();
    await seedPlatform();
    vi.spyOn(Trinket, 'findById').mockImplementation(() => Promise.resolve(
      { id: 'sub-13b', lang: 'python3', courseId: '5f000000000000000000000a' }));

    await reviewLaunch('/lti/review/sub-13b', defaults.user.email);

    expect(flow.lastResponse.statusCode).toBe(403);
    expect(flow.lastResponse.headers.location || '').not.toContain('/lti/review-panel');
  });

  it('404s a review launch for a submission that does not exist', async () => {
    await ownedCourse();
    await seedPlatform();
    const spy = vi.spyOn(Trinket, 'findById').mockImplementation(() => Promise.resolve(null));

    await reviewLaunch('/lti/review/sub-missing', defaults.user.email);

    expect(spy).toHaveBeenCalledWith('sub-missing');
    expect(flow.lastResponse.statusCode).toBe(404);
  });

  it('leaves a NON-review launch on its normal path', async () => {
    await ownedCourse();
    await seedPlatform();
    const spy = vi.spyOn(Trinket, 'findById');

    await reviewLaunch('/lti/launch', defaults.user.email);

    expect(spy, 'a plain launch must not look up a submission').not.toHaveBeenCalled();
    expect(flow.lastResponse.headers.location || '').not.toContain('/lti/review-panel');
  });
});
