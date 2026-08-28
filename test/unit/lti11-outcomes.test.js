'use strict';

// Basic Outcomes is the only way to reach a 1.1 platform, and its two classic
// failure modes are both silent: a signature that omits oauth_body_hash, and a
// POX response that says "failure" inside an HTTP 200.
const o = require('../../lib/util/lti11Outcomes');
const v = require('../../lib/util/lti11Verify');

const SERVICE = 'https://lms.example/outcomes';
const KEY = 'consumer-key';
const SECRET = 'consumer-secret';

describe('bodyHash', () => {
  it('matches the OAuth Request Body Hash spec vector', () => {
    // RFC-era example: body "Hello World!" hashes to this.
    expect(o.bodyHash('Hello World!')).toBe('Lve95gjOVATpfV8EL5X4nxwjKHE=');
  });

  it('is sensitive to any body change', () => {
    expect(o.bodyHash('a')).not.toBe(o.bodyHash('b'));
  });
});

describe('buildReplaceResult', () => {
  const base = { sourcedId: 'sid-1', launchUrl: 'https://tool.example/lti/review/abc', messageId: 'm-1' };

  it('carries the review URL as resultData/ltiLaunchUrl', () => {
    expect(o.buildReplaceResult(base))
      .toContain('<resultData><ltiLaunchUrl>https://tool.example/lti/review/abc</ltiLaunchUrl></resultData>');
  });

  it('sends NO score by default — trinket has no concept of a grade', () => {
    expect(o.buildReplaceResult(base)).not.toContain('resultScore');
  });

  it('includes a score only when one is explicitly supplied', () => {
    const xml = o.buildReplaceResult(Object.assign({ score: 0.75 }, base));
    expect(xml).toContain('<resultScore>');
    expect(xml).toContain('<textString>0.75</textString>');
  });

  it('treats a zero score as a real score, not as absent', () => {
    expect(o.buildReplaceResult(Object.assign({ score: 0 }, base))).toContain('<textString>0</textString>');
  });

  it('escapes XML metacharacters in the launch URL and sourcedid', () => {
    const xml = o.buildReplaceResult({ sourcedId: 'a&b', launchUrl: 'https://t/x?a=1&b=<2>', messageId: 'm' });
    expect(xml).toContain('a&amp;b');
    expect(xml).toContain('a=1&amp;b=&lt;2&gt;');
    expect(xml).not.toMatch(/<ltiLaunchUrl>[^<]*<2>/);
  });
});

describe('authHeader', () => {
  const hash = o.bodyHash('<xml/>');
  const header = o.authHeader('POST', SERVICE, KEY, SECRET, hash, { nonce: 'n1', timestamp: 1700000000 });

  it('carries oauth_body_hash — without it the body is unsigned', () => {
    expect(header).toContain('oauth_body_hash=');
  });

  it('produces a signature that verifies against the same base string', () => {
    const parsed = {};
    header.replace(/^OAuth /, '').split(',').forEach(pair => {
      const m = /^([^=]+)="(.*)"$/.exec(pair);
      parsed[decodeURIComponent(m[1])] = decodeURIComponent(m[2]);
    });
    const expected = v.sign('POST', SERVICE, {
      oauth_body_hash: hash, oauth_consumer_key: KEY, oauth_nonce: 'n1',
      oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '1700000000', oauth_version: '1.0'
    }, SECRET);
    expect(parsed.oauth_signature).toBe(expected);
  });

  it('changes signature when the body hash changes', () => {
    const other = o.authHeader('POST', SERVICE, KEY, SECRET, o.bodyHash('<different/>'),
                               { nonce: 'n1', timestamp: 1700000000 });
    expect(other).not.toBe(header);
  });
});

describe('readVerdict', () => {
  const envelope = (major, desc) =>
    `<imsx_POXEnvelopeResponse><imsx_statusInfo><imsx_codeMajor>${major}</imsx_codeMajor>` +
    `<imsx_description>${desc}</imsx_description></imsx_statusInfo></imsx_POXEnvelopeResponse>`;

  it('reads success', () => {
    expect(o.readVerdict(envelope('success', 'ok')).ok).toBe(true);
  });

  it('reads failure and keeps the platform description', () => {
    const vd = o.readVerdict(envelope('failure', 'resultScore is required'));
    expect(vd.ok).toBe(false);
    expect(vd.description).toBe('resultScore is required');
  });

  it('treats an unparseable response as failure rather than success', () => {
    expect(o.readVerdict('not xml').ok).toBe(false);
    expect(o.readVerdict('').ok).toBe(false);
  });
});

describe('postSubmission', () => {
  const args = { serviceUrl: SERVICE, consumerKey: KEY, secret: SECRET,
                 sourcedId: 'sid-1', launchUrl: 'https://tool.example/lti/review/abc' };
  let calls;
  beforeEach(() => { calls = []; });
  const stubFetch = (status, text) => {
    global.fetch = (url, init) => { calls.push({ url, init });
      return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(text) }); };
  };
  afterEach(() => { delete global.fetch; });

  const ok = '<imsx_POXEnvelopeResponse><imsx_statusInfo><imsx_codeMajor>success</imsx_codeMajor></imsx_statusInfo></imsx_POXEnvelopeResponse>';

  it('posts XML with an OAuth header to the outcome service', async () => {
    stubFetch(200, ok);
    await o.postSubmission(args);
    expect(calls[0].url).toBe(SERVICE);
    expect(calls[0].init.headers['content-type']).toBe('application/xml');
    expect(calls[0].init.headers.authorization).toMatch(/^OAuth /);
    expect(calls[0].init.body).toContain('replaceResultRequest');
  });

  it('signs the body it actually sends', async () => {
    stubFetch(200, ok);
    await o.postSubmission(args);
    expect(calls[0].init.headers.authorization)
      .toContain(encodeURIComponent(o.bodyHash(calls[0].init.body)));
  });

  it('throws with the platform description when the POX says failure', async () => {
    stubFetch(200, '<imsx_statusInfo><imsx_codeMajor>failure</imsx_codeMajor>' +
                   '<imsx_description>resultScore is required</imsx_description></imsx_statusInfo>');
    await expect(o.postSubmission(args)).rejects.toThrow(/resultScore is required/);
  });

  it('does not mistake an HTTP 200 failure envelope for success', async () => {
    stubFetch(200, '<imsx_statusInfo><imsx_codeMajor>failure</imsx_codeMajor></imsx_statusInfo>');
    await expect(o.postSubmission(args)).rejects.toThrow(/failed/);
  });

  it('throws on a transport-level error', async () => {
    stubFetch(401, 'nope');
    await expect(o.postSubmission(args)).rejects.toThrow(/HTTP 401/);
  });
});

// --- readResult -------------------------------------------------------------
// Asking the platform what score a human entered, so trinket can stop asking the
// instructor to mark the same submission done twice. The subtle case is that
// "nobody has graded it yet" comes back as SUCCESS with an empty score, not as an
// error — treat that as a grade and every submission looks graded the moment a
// line item exists.
describe('buildReadResult', () => {
  it('asks for the result of one sourcedid', () => {
    const xml = o.buildReadResult({ sourcedId: 'sid-1', messageId: 'm-1' });
    expect(xml).toContain('<readResultRequest>');
    expect(xml).toContain('<sourcedId>sid-1</sourcedId>');
  });

  it('escapes the sourcedid', () => {
    expect(o.buildReadResult({ sourcedId: 'a&b<c', messageId: 'm' })).toContain('a&amp;b&lt;c');
  });
});

describe('readScore', () => {
  const env = (inner, major = 'success') =>
    `<imsx_statusInfo><imsx_codeMajor>${major}</imsx_codeMajor></imsx_statusInfo>${inner}`;

  it('reports a real score as graded', () => {
    const r = o.readScore(env('<result><resultScore><language>en</language><textString>0.92</textString></resultScore></result>'));
    expect(r.graded).toBe(true);
    expect(r.score).toBe(0.92);
  });

  it('treats a ZERO score as graded — a zero is a grade', () => {
    const r = o.readScore(env('<result><resultScore><textString>0</textString></resultScore></result>'));
    expect(r.graded).toBe(true);
    expect(r.score).toBe(0);
  });

  it('treats an EMPTY score as not-yet-graded, not as an error', () => {
    const r = o.readScore(env('<result><resultScore><textString></textString></resultScore></result>'));
    expect(r.ok).toBe(true);
    expect(r.graded).toBe(false);
    expect(r.score).toBeNull();
  });

  it('treats a missing resultScore as not-yet-graded', () => {
    const r = o.readScore(env('<result></result>'));
    expect(r.ok).toBe(true);
    expect(r.graded).toBe(false);
  });

  it('does not report graded when the platform says failure', () => {
    const r = o.readScore(env('<result><resultScore><textString>0.5</textString></resultScore></result>', 'failure'));
    expect(r.ok).toBe(false);
    expect(r.graded).toBe(false);
  });

  it('ignores a non-numeric score rather than trusting it', () => {
    const r = o.readScore(env('<result><resultScore><textString>N/A</textString></resultScore></result>'));
    expect(r.graded).toBe(false);
    expect(r.score).toBeNull();
  });
});

describe('readResult over the wire', () => {
  const args = { serviceUrl: SERVICE, consumerKey: KEY, secret: SECRET, sourcedId: 'sid-1' };
  let calls;
  beforeEach(() => { calls = []; });
  afterEach(() => { delete global.fetch; });
  const stubFetch = (status, text) => {
    global.fetch = (url, init) => { calls.push({ url, init });
      return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(text) }); };
  };
  const ok = (inner) =>
    `<imsx_statusInfo><imsx_codeMajor>success</imsx_codeMajor></imsx_statusInfo>${inner}`;

  it('signs the body it sends, like replaceResult does', async () => {
    stubFetch(200, ok('<resultScore><textString>1</textString></resultScore>'));
    await o.readResult(args);
    expect(calls[0].init.headers.authorization)
      .toContain(encodeURIComponent(o.bodyHash(calls[0].init.body)));
    expect(calls[0].init.body).toContain('readResultRequest');
  });

  it('returns graded:false for an ungraded submission without throwing', async () => {
    stubFetch(200, ok('<resultScore><textString></textString></resultScore>'));
    await expect(o.readResult(args)).resolves.toMatchObject({ graded: false, score: null });
  });

  it('throws when the platform reports failure', async () => {
    stubFetch(200, '<imsx_statusInfo><imsx_codeMajor>failure</imsx_codeMajor>' +
                   '<imsx_description>Unknown sourcedid</imsx_description></imsx_statusInfo>');
    await expect(o.readResult(args)).rejects.toThrow(/Unknown sourcedid/);
  });

  it('throws on a transport error', async () => {
    stubFetch(500, 'nope');
    await expect(o.readResult(args)).rejects.toThrow(/HTTP 500/);
  });
});
