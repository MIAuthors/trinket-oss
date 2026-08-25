'use strict';

// OAuth 1.0a canonicalization is the classic source of LTI 1.1 tool bugs —
// every rule here is one that has bitten a real implementation.
const v = require('../../lib/util/lti11Verify');

const URL_ = 'https://trinket-merge-test.web.app/lti/launch';
const SECRET = 'topsecret';

function launchParams(extra) {
  return Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-1',
    user_id: 'u-42',
    roles: 'Instructor',
    oauth_consumer_key: 'k1',
    oauth_nonce: 'n' + Math.random(),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  }, extra || {});
}

describe('rfc3986 encoding', () => {
  it("encodes the characters encodeURIComponent misses, and never emits '+'", () => {
    expect(v.rfc3986("a b!'()*~-._")).toBe("a%20b%21%27%28%29%2A~-._");
  });
});

describe('url normalization', () => {
  it('lowercases scheme/host, strips default ports, drops query and fragment', () => {
    expect(v.normalizeUrl('HTTPS://Example.COM:443/lti/launch?x=1#f'))
      .toBe('https://example.com/lti/launch');
    expect(v.normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
    expect(v.normalizeUrl('http://example.com:3000/a')).toBe('http://example.com:3000/a');
  });
});

describe('sign/verify', () => {
  it('roundtrips a launch', () => {
    const p = launchParams();
    p.oauth_signature = v.sign('POST', URL_, p, SECRET);
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: SECRET })).toEqual({ ok: true });
  });

  it('is order-independent — same signature whatever the param order', () => {
    const p = launchParams({ custom_trinket_course: 'abc', zz_last: '1' });
    const sig = v.sign('POST', URL_, p, SECRET);
    const shuffled = {};
    Object.keys(p).reverse().forEach((k) => { shuffled[k] = p[k]; });
    expect(v.sign('POST', URL_, shuffled, SECRET)).toBe(sig);
  });

  it('rejects any tampered parameter', () => {
    const p = launchParams({ roles: 'Learner' });
    p.oauth_signature = v.sign('POST', URL_, p, SECRET);
    p.roles = 'Instructor';   // privilege-escalation attempt
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: SECRET }).reason)
      .toBe('signature mismatch');
  });

  it('rejects the wrong secret', () => {
    const p = launchParams();
    p.oauth_signature = v.sign('POST', URL_, p, SECRET);
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: 'other' }).ok).toBe(false);
  });

  it('rejects a stale timestamp (replay window)', () => {
    const p = launchParams({ oauth_timestamp: String(Math.floor(Date.now() / 1000) - 9999) });
    p.oauth_signature = v.sign('POST', URL_, p, SECRET);
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: SECRET }).reason)
      .toBe('timestamp outside window');
  });

  it('signs values with spaces/unicode the RFC way (space -> %20, not +)', () => {
    const p = launchParams({ lis_person_name_full: 'Sam Stüdent' });
    p.oauth_signature = v.sign('POST', URL_, p, SECRET);
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: SECRET }).ok).toBe(true);
    expect(v.normalizeParams(p)).toContain('lis_person_name_full=Sam%20St%C3%BCdent');
  });

  it('handles repeated parameter names', () => {
    const p = launchParams({ tag: ['b', 'a'] });
    p.oauth_signature = v.sign('POST', URL_, p, SECRET);
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: SECRET }).ok).toBe(true);
    // sorted by value within the repeated key
    expect(v.normalizeParams(p).indexOf('tag=a')).toBeLessThan(v.normalizeParams(p).indexOf('tag=b'));
  });

  it('refuses non-HMAC-SHA1 methods and missing oauth fields', () => {
    const p = launchParams({ oauth_signature_method: 'PLAINTEXT' });
    p.oauth_signature = 'x';
    expect(v.verify({ method: 'POST', url: URL_, params: p, secret: SECRET }).reason)
      .toBe('unsupported signature method');
    const q = launchParams(); delete q.oauth_nonce; q.oauth_signature = 'x';
    expect(v.verify({ method: 'POST', url: URL_, params: q, secret: SECRET }).reason)
      .toBe('missing oauth fields');
  });
});

describe('launchUrlFromRequest', () => {
  const resolve = require('../../lib/util/publicHostname').resolve;
  const APP = { hostname: 'trinket.example', knownHosts: ['trinket-cdn.web.app'], protocol: 'https' };
  const req = (headers, hostname, path) => ({ headers, info: { hostname }, path: path || '/lti/launch' });

  it('reconstructs the public URL behind a CDN front door', () => {
    expect(v.launchUrlFromRequest(
      req({ 'x-forwarded-host': 'trinket-cdn.web.app', 'x-forwarded-proto': 'https', host: 'backend.run.app' }, 'backend.run.app'),
      APP, resolve
    )).toBe('https://trinket-cdn.web.app/lti/launch');
  });

  it('keeps a local dev port', () => {
    expect(v.launchUrlFromRequest(
      req({ host: 'localhost:3001' }, 'localhost'), { hostname: 'localhost', protocol: 'http' }, resolve
    )).toBe('http://localhost:3001/lti/launch');
  });

  it('drops explicit default ports from the host header', () => {
    expect(v.launchUrlFromRequest(
      req({ host: 'localhost:80' }, 'localhost'), { hostname: 'localhost', protocol: 'https' }, resolve
    )).toBe('https://localhost/lti/launch');
  });

  it('never adopts a foreign forwarded host', () => {
    expect(v.launchUrlFromRequest(
      req({ 'x-forwarded-host': 'evil.example.com', host: 'backend.run.app' }, 'backend.run.app'),
      APP, resolve
    )).toBe('https://backend.run.app/lti/launch');
  });
});
