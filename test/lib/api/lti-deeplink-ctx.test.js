// The deep-link flow must survive a refused launch cookie (#217).
//
// A deep-linking launch lands in the LMS's iframe. When the browser blocks
// third-party cookies the session the launch just created never comes back, so
// the picker — and the select step after it — cannot rely on request.yar. The
// launch therefore also signs the deep-link CONTEXT (which request is being
// answered: return URL, mode, platform coordinates — and deliberately NO identity)
// into the picker URL, and both steps accept it as a fallback to the session.
//
// The guidance page (#220) remains what an instructor sees when there is no way
// to continue; the signed ctx is the way to continue. These tests pin the
// hand-off between the two.
//
// Only the id_token signature check is stubbed (ltiVerify.verifyLaunchToken);
// state, nonce, deployment, the launch branch, the ctx signing and the picker/select
// handlers all run for real, on a real ephemeral keypair.
const flow        = require('../../helpers/flow.cjs');
const config      = require('config');
const defaults    = require('../../helpers/defaults');
const ltiState    = require('../../../lib/util/ltiState');
const ltiVerify   = require('../../../lib/util/ltiVerify');
const ltiKeys     = require('../../../lib/util/ltiKeys');
const LtiPlatform = require('../../../lib/models/ltiPlatform');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const v11         = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');
const crypto      = require('crypto');

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
const DL  = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
const ISS = 'https://canvas-dl.test';
const CID = 'client-dl';
const DEP = 'deployment-dl';
const RETURN = 'https://canvas-dl.test/courses/7/deep_linking_response';

async function server() {
  const s = await require('../../../app.js');
  try { await s.initialize(); }
  catch (e) { if (!/Cannot initialize server while it is/i.test(String(e && e.message))) throw e; }
  return s;
}

function cookieHeader(setCookie) {
  return (setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

// yar keeps a session that fits under maxCookieSize IN the cookie (only larger
// ones go to the cache), so a request that changes the session hands the new
// state back in set-cookie. Follow it the way a browser would.
function nextCookie(res, prev) {
  return res.headers['set-cookie'] ? cookieHeader(res.headers['set-cookie']) : prev;
}

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

function ctxFromLocation(location) {
  const m = /[?&]ctx=([^&]+)/.exec(location || '');
  return m ? decodeURIComponent(m[1]) : null;
}

async function seedPlatform() {
  const existing = await new Promise((resolve) =>
    LtiPlatform.findByIssuer(ISS, CID, (err, p) => resolve(err ? null : p)));
  if (existing) return existing;
  const p = new LtiPlatform({
    issuer: ISS, clientId: CID,
    authLoginUrl: ISS + '/api/lti/authorize_redirect',
    jwksUrl: ISS + '/api/lti/security/jwks',
    deploymentIds: [DEP], status: 'active', trustEmail: true,
    name: 'Test Canvas DL', productFamily: 'canvas'
  });
  await p.save();
  return p;
}

// The instructor's OWN first-party session: signed in to this deploy in a
// top-level tab, owning a course the picker can offer. This is the session that
// keeps working when the launch cookie is refused — it is what "Continue in a
// new tab" relies on.
async function ownerSession() {
  flow.cookies = {};
  await flow.switchUser('user');
  await flow.createCourse({ name: 'DL Ctx ' + Math.random().toString(36).slice(2, 7) });
  const course = flow.lastResponse.body.course;
  const cookies = flow.cookies.user;
  flow.cookies = {};
  return { course, cookie: cookieHeader(cookies) };
}

// A 1.3 deep-linking launch (Canvas link_selection by default). Returns the launch
// response; its set-cookie is the launch session, its Location carries the ctx.
async function deepLinkLaunch13(opts) {
  opts = opts || {};
  const nonce = 'n-' + Math.random().toString(36).slice(2);
  const state = ltiState.sign({ nonce, iss: ISS, clientId: CID, target: config.url + '/lti/launch' });
  const claims = { iss: ISS, sub: 'dl-instructor-sub', nonce, email: defaults.user.email, name: 'Test User' };
  claims[LTI + 'deployment_id'] = DEP;
  claims[LTI + 'message_type']  = 'LtiDeepLinkingRequest';
  claims[LTI + 'version']       = '1.3.0';
  claims[LTI + 'roles']         = ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'];
  claims[LTI + 'tool_platform'] = { product_family_code: 'canvas' };
  claims[DL + 'deep_linking_settings'] = {
    deep_link_return_url: opts.returnUrl || RETURN, data: 'opaque-from-canvas',
    accept_types: ['ltiResourceLink'],
    accept_multiple: (opts.acceptMultiple === undefined) ? true : opts.acceptMultiple
  };
  vi.spyOn(ltiVerify, 'verifyLaunchToken').mockImplementation(() => Promise.resolve(claims));
  flow.cookies = {};
  await flow._inject('POST', 'http://localhost/lti/launch', { state, id_token: 'stub.jwt.token' });
  return flow.lastResponse;
}

describe('deep-link context survives a refused launch cookie (LTI 1.3)', () => {
  beforeEach(() => { flow.cookies = {}; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('(a) the launch redirects to a picker URL carrying a signed ctx with NO identity in it', async () => {
    await seedPlatform();
    const res = await deepLinkLaunch13();
    expect(res.statusCode, JSON.stringify(res.body).slice(0, 300)).toBe(302);
    expect(res.headers.location).toMatch(/^\/lti\/deep-link\?ctx=/);

    const ctx = ctxFromLocation(res.headers.location);
    expect(ctx.split('.').length, 'a compact JWS').toBe(3);
    const payload = decodeJwtPayload(ctx);
    const json = JSON.stringify(payload);
    expect(json).toContain(RETURN);
    // The security property: a leaked picker URL must not be a bearer credential.
    expect(payload.sub).toBeUndefined();
    expect(payload.uid).toBeUndefined();
    expect(json).not.toContain(defaults.user.email);
    expect(json).not.toContain('dl-instructor-sub');
  });

  it('(b) framed, no cookie, valid ctx: offers "Continue in a new tab" — not /login, not the cookie guidance', async () => {
    await seedPlatform();
    const launch = await deepLinkLaunch13();
    const ctx = ctxFromLocation(launch.headers.location);
    expect(ctx, 'launch must carry a ctx').toBeTruthy();

    const s = await server();
    const res = await s.inject({
      method: 'GET', url: launch.headers.location,
      headers: { 'sec-fetch-dest': 'iframe' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.location || '').not.toMatch(/\/login/);
    expect(res.payload).toMatch(/Continue in a new tab/);
    // The link out of the frame carries the same ctx, so the top-level picker
    // still knows which deep-link request it is answering.
    expect(res.payload).toContain(encodeURIComponent(ctx));
    expect(res.payload).toContain('target="_blank"');
    // Not the dead-end page: that one is for when there is no way forward.
    expect(res.payload).not.toMatch(/Sites allowed to use third-party cookies/);
  });

  it('(b) top-level with the instructor\'s own session (no launch session) and a valid ctx: renders the picker', async () => {
    await seedPlatform();
    const owner = await ownerSession();
    const launch = await deepLinkLaunch13();
    const ctx = ctxFromLocation(launch.headers.location);

    const s = await server();
    const res = await s.inject({
      method: 'GET', url: launch.headers.location,
      headers: { 'sec-fetch-dest': 'document', cookie: owner.cookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(owner.course.name);
    // Threaded into every select form so the select step survives the same way.
    expect(res.payload).toMatch(/name="ctx"/);
    expect(res.payload).toContain('value="' + ctx + '"');
  });

  it('(b) top-level, signed out, valid ctx: sends the instructor to sign in (first-party), not to the cookie page', async () => {
    await seedPlatform();
    const launch = await deepLinkLaunch13();
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: launch.headers.location,
      headers: { 'sec-fetch-dest': 'document' }
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('(c) POST select with ctx and the instructor\'s own session (no launch session) returns the signed response', async () => {
    await seedPlatform();
    const owner = await ownerSession();
    const launch = await deepLinkLaunch13();
    const ctx = ctxFromLocation(launch.headers.location);

    const s = await server();
    const res = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { cookie: owner.cookie },
      payload: { ctx, targetType: 'course', courseId: owner.course.id, title: owner.course.name }
    });
    expect(res.statusCode, String(res.payload).slice(0, 300)).toBe(200);
    expect(res.payload).toContain(RETURN);
    const m = /name="JWT" value="([^"]+)"/.exec(res.payload);
    expect(m, 'auto-posting JWT form').toBeTruthy();
    const dl = decodeJwtPayload(m[1]);
    expect(dl[LTI + 'message_type']).toBe('LtiDeepLinkingResponse');
    expect(dl[DL + 'data']).toBe('opaque-from-canvas');
    expect(dl[DL + 'content_items'][0].custom.trinket_course).toBe(String(owner.course.id));
  });

  it('(c) POST select with a valid ctx but NO session is refused — ctx is not a credential', async () => {
    await seedPlatform();
    const owner = await ownerSession();
    const launch = await deepLinkLaunch13();
    const ctx = ctxFromLocation(launch.headers.location);

    const s = await server();
    const res = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { 'sec-fetch-dest': 'document' },
      payload: { ctx, targetType: 'course', courseId: owner.course.id, title: 'x' }
    });
    expect(res.statusCode).not.toBe(200);
    expect(res.payload || '').not.toContain('name="JWT"');
  });

  it('(d) a tampered ctx, framed and cookieless, gets the cookie guidance — not the picker, not the continue page', async () => {
    await seedPlatform();
    const launch = await deepLinkLaunch13();
    const ctx = ctxFromLocation(launch.headers.location);
    const bad = ctx.slice(0, -4) + 'AAAA';

    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/lti/deep-link?ctx=' + encodeURIComponent(bad),
      headers: { 'sec-fetch-dest': 'iframe' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatch(/third-party cookies/i);
    expect(res.payload).not.toMatch(/Continue in a new tab/);
    expect(res.payload).not.toMatch(/name="ctx"/);
  });

  it('(d) an expired ctx is rejected the same way', async () => {
    const expired = ltiKeys.signJwt({ typ: 'lti-dl-ctx', ru: RETURN, mode: 'both' }, { expiresIn: -60 });
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/lti/deep-link?ctx=' + encodeURIComponent(expired),
      headers: { 'sec-fetch-dest': 'iframe' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatch(/third-party cookies/i);
    expect(res.payload).not.toMatch(/Continue in a new tab/);
  });

  it('(d) a valid ctx never substitutes for the session when the session is there', async () => {
    // The launch cookie DID survive (ordinary Chrome). The session's own context
    // wins and the picker renders exactly as before — ctx is a fallback only.
    await seedPlatform();
    await ownerSession();
    const launch = await deepLinkLaunch13();
    const launchCookie = cookieHeader(launch.headers['set-cookie']);
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/lti/deep-link',      // no ctx at all
      headers: { 'sec-fetch-dest': 'iframe', cookie: launchCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Add Trinket Content');
  });
});

// The 1.1 entry point shares the picker, so it must carry the ctx too when a
// keypair exists. The no-keypair case — a 1.1-only deploy — is guarded by
// test/lib/api/lti11-deeplink.test.js, which runs WITHOUT LTI_PRIVATE_KEY and
// expects the bare /lti/deep-link redirect.
describe('deep-link context survives a refused launch cookie (LTI 1.1)', () => {
  const AUTHORITY = 'localhost';
  const PATH = '/lti11/launch';
  const RETURN11 = 'https://canvas.example/courses/1/external_content/success/external_tool_dialog';
  const serverUrl = () => v11.launchUrlFromRequest(
    { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path: PATH },
    config.app.url, publicHostname.resolve);

  beforeEach(() => { flow.cookies = {}; });

  async function seedConsumer() {
    const c = new LtiConsumer({ key: 'dlctx-' + Math.random().toString(36).slice(2, 10),
                                secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'deep link ctx test' });
    await c.save();
    return c;
  }

  function contentItemLaunch(consumer) {
    const p = {
      lti_message_type: 'ContentItemSelectionRequest',
      lti_version: 'LTI-1p0',
      user_id: 'instructor-dlctx-1',
      roles: 'Instructor',
      lis_person_contact_email_primary: defaults.user.email,
      lis_person_name_full: 'Test User',
      content_item_return_url: RETURN11,
      accept_multiple: 'false',
      oauth_consumer_key: consumer.key,
      oauth_nonce: 'dl-' + Math.random().toString(36).slice(2),
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_version: '1.0'
    };
    p.oauth_signature = v11.sign('POST', serverUrl(), p, consumer.secret);
    return p;
  }

  it('a 1.1 content-item launch carries the ctx and the select step completes on the instructor\'s own session', async () => {
    const owner = await ownerSession();
    const consumer = await seedConsumer();
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, contentItemLaunch(consumer));
    expect(flow.lastResponse.statusCode).toBe(302);
    expect(flow.lastResponse.headers.location).toMatch(/^\/lti\/deep-link\?ctx=/);
    const ctx = ctxFromLocation(flow.lastResponse.headers.location);
    expect(JSON.stringify(decodeJwtPayload(ctx))).not.toContain(consumer.secret);

    const s = await server();
    const res = await s.inject({
      method: 'POST', url: 'http://' + AUTHORITY + '/lti/deep-link/select',
      headers: { cookie: owner.cookie },
      payload: { ctx, targetType: 'assignment', courseId: owner.course.id, targetId: 'material-1', title: 'HW 1' }
    });
    expect(res.statusCode, String(res.payload).slice(0, 300)).toBe(200);
    expect(res.payload).toContain(RETURN11);
    expect(res.payload).toContain('oauth_signature');
    expect(res.payload).toContain('trinket_assignment');
  });
});

// Review finding 1: a VALID explicit ctx must name the request being answered.
// The session copy of the context (ltiDeepLink) is never cleared by a launch in a
// DIFFERENT session — the instructor's own top-level tab keeps whatever the last
// picker render stored — so "session first" answers an EARLIER launch when a
// second one happens. Two launches A (content mode) then B (assignment mode):
// B's ctx must render B's picker and return to B's URL wherever it is presented.
describe('an explicit ctx names the deep-link request being answered', () => {
  const RETURN_B = 'https://canvas-dl.test/courses/7/deep_linking_response_B';
  beforeEach(() => { flow.cookies = {}; });
  afterEach(() => { vi.restoreAllMocks(); });

  async function twoLaunches() {
    await seedPlatform();
    const owner = await ownerSession();
    const a = await deepLinkLaunch13();                                              // content mode
    const b = await deepLinkLaunch13({ returnUrl: RETURN_B, acceptMultiple: false });  // assignment mode
    return {
      owner,
      cookieA: cookieHeader(a.headers['set-cookie']), ctxA: ctxFromLocation(a.headers.location),
      cookieB: cookieHeader(b.headers['set-cookie']), ctxB: ctxFromLocation(b.headers.location)
    };
  }

  it('picker: B\'s ctx presented in a session still holding A renders B\'s picker', async () => {
    const t = await twoLaunches();
    const s = await server();
    const res = await s.inject({
      method: 'GET', url: '/lti/deep-link?ctx=' + encodeURIComponent(t.ctxB),
      headers: { 'sec-fetch-dest': 'document', cookie: t.cookieA }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Add a Trinket Assignment');
    expect(res.payload).not.toContain('Add Trinket Content');
  });

  it('select: B\'s ctx presented in a session still holding A returns to B', async () => {
    const t = await twoLaunches();
    const s = await server();
    const res = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { cookie: t.cookieA },
      payload: { ctx: t.ctxB, targetType: 'course', courseId: t.owner.course.id, title: 'C' }
    });
    expect(res.statusCode, String(res.payload).slice(0, 300)).toBe(200);
    expect(res.payload).toContain(RETURN_B);
    expect(res.payload).not.toContain('action="' + RETURN + '"');
  });

  it('select: A\'s still-valid ctx answers A even from B\'s session', async () => {
    const t = await twoLaunches();
    const s = await server();
    const res = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { cookie: t.cookieB },
      payload: { ctx: t.ctxA, targetType: 'course', courseId: t.owner.course.id, title: 'C' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('action="' + RETURN + '"');
    expect(res.payload).not.toContain(RETURN_B);
  });

  it('a picker rendered from ctx updates the session, so a ctx-less select in that tab agrees', async () => {
    const t = await twoLaunches();
    const s = await server();
    const picker = await s.inject({
      method: 'GET', url: '/lti/deep-link?ctx=' + encodeURIComponent(t.ctxB),
      headers: { 'sec-fetch-dest': 'document', cookie: t.cookieA }
    });
    const res = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { cookie: nextCookie(picker, t.cookieA) },
      payload: { targetType: 'course', courseId: t.owner.course.id, title: 'C' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(RETURN_B);
  });

  it('a completed select clears the session context', async () => {
    const t = await twoLaunches();
    const s = await server();
    const first = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { cookie: t.cookieA },
      payload: { targetType: 'course', courseId: t.owner.course.id, title: 'C' }
    });
    expect(first.payload).toContain('action="' + RETURN + '"');
    const again = await s.inject({
      method: 'POST', url: '/lti/deep-link/select',
      headers: { cookie: nextCookie(first, t.cookieA) },
      payload: { targetType: 'course', courseId: t.owner.course.id, title: 'C' }
    });
    expect(again.payload).not.toContain('action="' + RETURN + '"');
    expect(again.payload).toMatch(/expired/i);
  });
});
