import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import ctx from '../../../lib/util/ltiDeepLinkCtx.js';

// A REAL keypair, not a stubbed signer: the point of these tests is that a token
// actually verifies, and that a tampered one actually does not. Stubbing signJwt to
// identity (as some sibling tests do, for other reasons) would assert nothing here.
beforeAll(() => {
  if (!process.env.LTI_PRIVATE_KEY) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.LTI_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
  }
});

// The deep-link context token (#217). Its whole purpose is to let the picker work when
// the browser refused the cookie the launch set, WITHOUT becoming a bearer credential
// for the instructor's account — so the identity assertions below matter as much as
// the round-trip one.
describe('ltiDeepLinkCtx', () => {
  const dl11 = {
    version: '1.1',
    deep_link_return_url: 'https://lms.example.edu/return',
    data: 'opaque-from-lms',
    mode: 'both',
    acceptMultiple: true,
    assignmentAllowed: true,
    consumerKey: 'key-123',
  };

  it('round-trips the fields the picker and select step need', () => {
    const out = ctx.verify(ctx.sign(dl11));
    expect(out).toBeTruthy();
    expect(out.version).toBe('1.1');
    expect(out.deep_link_return_url).toBe(dl11.deep_link_return_url);
    expect(out.data).toBe('opaque-from-lms');
    expect(out.mode).toBe('both');
    expect(out.acceptMultiple).toBe(true);
    expect(out.consumerKey).toBe('key-123');
  });

  it('round-trips the 1.3 platform coordinates', () => {
    const out = ctx.verify(ctx.sign({
      version: '1.3',
      deep_link_return_url: 'https://lms.example.edu/dl',
      platformIss: 'https://lms.example.edu',
      platformCid: 'client-1',
      deploymentId: 'dep-1',
    }));
    expect(out.platformIss).toBe('https://lms.example.edu');
    expect(out.platformCid).toBe('client-1');
    expect(out.deploymentId).toBe('dep-1');
  });

  // The security property. If this ever fails, a leaked picker URL — a referrer, a
  // screenshot in a support ticket, a proxy log — becomes a live session.
  it('carries NO user identity', () => {
    const token = ctx.sign({ ...dl11, userId: 'u-secret', user: { id: 'u-secret' } });
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    expect(JSON.stringify(decoded)).not.toContain('u-secret');
    expect(decoded.uid).toBeUndefined();
    expect(decoded.sub).toBeUndefined();
    expect(ctx.verify(token).userId).toBeUndefined();
  });

  // Regression: signing used to throw when no LTI 1.3 keypair was configured, which
  // made every LTI 1.1 deep-link launch fail on a 1.1-only deploy — 1.1 needs no such
  // key. The token is an enhancement and must never break a launch that would
  // otherwise work, so absence of a key degrades to "no token".
  // NOTE: the "no signing key" path — sign() returning null rather than throwing — is
  // covered by test/lib/api/lti11-deeplink.test.js, which drives a real 1.1 launch and
  // failed outright when signing threw. It is not unit-tested here on purpose: the key
  // cannot be removed from this context (loadPem() also reads config.app.lti.privateKey),
  // and neither stubbing the imported object nor vi.doMock intercepts the CJS
  // require('./ltiKeys') inside the module. The API test is the honest guard.

  it('refuses a token of the wrong type', async () => {
    const ltiKeys = (await import('../../../lib/util/ltiKeys.js')).default;
    const wrong = ltiKeys.signJwt({ typ: 'lti-state', ru: 'https://evil.example/' }, { expiresIn: '5m' });
    expect(ctx.verify(wrong)).toBeNull();
  });

  it('refuses tampered, empty and malformed tokens', () => {
    expect(ctx.verify(null)).toBeNull();
    expect(ctx.verify('')).toBeNull();
    expect(ctx.verify('not.a.jwt')).toBeNull();
    const t = ctx.sign(dl11);
    expect(ctx.verify(t.slice(0, -3) + 'aaa')).toBeNull();
  });
});
