import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Regression guard for a spec-compliance bug that cost a live deployment twice.
//
// The LTI security framework requires a `nonce` on EVERY message, including the
// DeepLinkingResponse. buildDeepLinkingResponse omitted it. Canvas and Moodle —
// where this code was built and tested — accept the response anyway, so the gap
// was invisible there. D2L/Brightspace validates strictly and bounces the return
// POST to its own generic "Not authorized to view the page" screen, which looks
// like a permissions problem rather than a malformed response. Basic resource-link
// launches are unaffected (only the DL path signs a response JWT), which makes it
// harder still to place.
//
// It was fixed once on a deploy branch, never carried upstream, and silently
// dropped when that branch was reset onto main — reproducing the outage. This
// test exists so the claim can never be lost quietly again.
// ltiDeepLinking does `var ltiKeys = require('./ltiKeys')` at load and calls
// ltiKeys.signJwt(payload) at call time, so swapping the method on the shared
// module object captures the payload without needing a real signing key
// (the real signJwt throws when LTI_PRIVATE_KEY is unset, as in test).
const ltiKeys = require('../../../lib/util/ltiKeys');
const ltiDeepLinking = require('../../../lib/util/ltiDeepLinking');

let realSignJwt;
beforeAll(() => {
  realSignJwt = ltiKeys.signJwt;
  ltiKeys.signJwt = (payload) => payload;   // identity: hand back the claims
});
afterAll(() => { ltiKeys.signJwt = realSignJwt; });

function build(overrides) {
  return ltiDeepLinking.buildDeepLinkingResponse(Object.assign({
    platform: { clientId: 'client-abc', issuer: 'https://brightspace.example.edu' },
    settings: {},
    deploymentId: 'dep-1',
    contentItems: []
  }, overrides || {}));
}

describe('buildDeepLinkingResponse — required nonce', () => {
  it('includes a nonce claim', () => {
    const payload = build();
    expect(payload.nonce, 'DeepLinkingResponse must carry a nonce (D2L rejects without it)').toBeTruthy();
    expect(typeof payload.nonce).toBe('string');
  });

  it('uses a fresh nonce on every response', () => {
    // A reused nonce defeats the replay protection the claim exists for, and a
    // strict platform may reject a repeat.
    const a = build().nonce;
    const b = build().nonce;
    expect(a).not.toBe(b);
  });

  it('emits enough entropy to be a real nonce', () => {
    // 16 random bytes hex-encoded => 32 chars.
    expect(build().nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still carries the other required LTI-DL claims', () => {
    const payload = build();
    expect(payload.iss).toBe('client-abc');
    expect(payload.aud).toBe('https://brightspace.example.edu');
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/message_type']).toBe('LtiDeepLinkingResponse');
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/version']).toBe('1.3.0');
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id']).toBe('dep-1');
  });
});
