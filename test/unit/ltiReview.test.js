'use strict';

// The review seam is what lets ONE implementation serve both LTI versions, so the
// cases below deliberately cover the two shapes the review URL arrives in:
// a full target_link_uri (1.3) and a bare request path (1.1 relaunch).
const r = require('../../lib/util/ltiReview');

const userWith = (allowed) => ({
  hasPermission: (perm, kind, ctx) =>
    perm === 'send-submission-feedback' && kind === 'course' && ctx.id === allowed
});

describe('ltiReview.parseTarget', () => {
  it('reads the submission id from a 1.3 target_link_uri claim', () => {
    expect(r.parseTarget('https://tool.example/lti/review/sub123')).toBe('sub123');
  });

  it('reads it from a bare 1.1 relaunch path', () => {
    expect(r.parseTarget('/lti/review/sub123')).toBe('sub123');
  });

  it('stops at a query string or fragment', () => {
    expect(r.parseTarget('/lti/review/sub123?x=1')).toBe('sub123');
    expect(r.parseTarget('/lti/review/sub123#frag')).toBe('sub123');
  });

  it('returns null for a non-review launch', () => {
    expect(r.parseTarget('/lti/launch')).toBeNull();
    expect(r.parseTarget('https://tool.example/lti11/launch')).toBeNull();
  });

  // #14: the 1.1 review URL now rides on the installed launch path as a query
  // param, because Canvas will not launch a stored URL it cannot match to an
  // installed tool.
  // The query form is deliberately NOT here. parseTarget is shared with the 1.3
  // launch, which feeds it the target_link_uri claim (controllers/lti.js:723) —
  // so teaching it the query shape would silently make a 1.3 claim carrying
  // ?submission= a review launch, which it never was. 1.3 is meant to be
  // untouched by the #14 fix, so the query branch lives in targetFromRequest,
  // which only the 1.1 launch calls. Raised in review by @drewsday.
  it('does NOT read the query form — that shape belongs to targetFromRequest', () => {
    expect(r.parseTarget('/lti11/launch?submission=sub123')).toBeNull();
    expect(r.parseTarget('https://tool.example/lti11/launch?submission=sub123')).toBeNull();
  });

  it('does not mistake another launch param for a review target', () => {
    // The regex anchors on ?/& so a param merely ENDING in "submission" cannot
    // hijack a normal launch into a review.
    expect(r.parseTarget('/lti11/launch?assignment=material-123')).toBeNull();
    expect(r.parseTarget('/lti11/launch?resubmission=sub123')).toBeNull();
  });

  it('tolerates missing input rather than throwing', () => {
    expect(r.parseTarget('')).toBeNull();
    expect(r.parseTarget(undefined)).toBeNull();
    expect(r.parseTarget(null)).toBeNull();
  });
});

describe('ltiReview.advertisedUrl', () => {
  it('puts the 1.1 URL on the installed launch path', () => {
    expect(r.advertisedUrl('https://t.example', 'sub123', { version: '1.1' }))
      .toBe('https://t.example/lti11/launch?submission=sub123');
  });

  it('leaves 1.3 on its own path — nothing matches it against installed tools', () => {
    expect(r.advertisedUrl('https://t.example', 'sub123'))
      .toBe('https://t.example/lti/review/sub123');
  });

  // Round-trips through the reader each version actually uses. They differ on
  // purpose: 1.3 relaunches at its own endpoint and parses the target_link_uri
  // claim, so parseTarget reads it; 1.1 arrives as a real request on the
  // installed launch path, so targetFromRequest does.
  it('round-trips a 1.3 URL through parseTarget', () => {
    expect(r.parseTarget(r.advertisedUrl('https://t.example', 'sub123'))).toBe('sub123');
  });

  it('round-trips a 1.1 URL through targetFromRequest, as a launch would arrive', () => {
    const url = new URL(r.advertisedUrl('https://t.example', 'sub123', { version: '1.1' }));
    const request = {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
    expect(r.targetFromRequest(request)).toBe('sub123');
  });
});

describe('ltiReview.targetFromRequest', () => {
  it('reads the path form, for submissions Canvas stored before the fix', () => {
    expect(r.targetFromRequest({ path: '/lti/review/old-1', query: {} })).toBe('old-1');
  });

  it('reads the query form, which request.path alone cannot carry', () => {
    expect(r.targetFromRequest({ path: '/lti11/launch', query: { submission: 'new-1' } })).toBe('new-1');
  });

  // Agreeing with the verifier: controllers/lti.js signs Object.assign({}, query,
  // body) with body winning, so the handler must read that same merged object.
  it('prefers the signed params the verifier actually used', () => {
    const req = { path: '/lti11/launch', query: { submission: 'from-query' } };
    const signed = { submission: 'from-body' };   // what the signature covered
    expect(r.targetFromRequest(req, signed)).toBe('from-body');
  });

  it('falls back to merging query and payload the same way when not given them', () => {
    expect(r.targetFromRequest({ path: '/lti11/launch', query: { submission: 'q' },
                                 payload: { submission: 'b' } })).toBe('b');
  });

  it('leaves an ordinary launch alone', () => {
    expect(r.targetFromRequest({ path: '/lti11/launch', query: { assignment: 'm1' } })).toBeNull();
    expect(r.targetFromRequest(null)).toBeNull();
  });
});

describe('ltiReview.canReview', () => {
  const submission = { id: 'sub123', lang: 'python3', courseId: 'course-A' };

  it('allows a grader holding send-submission-feedback on the submission course', () => {
    expect(r.canReview(userWith('course-A'), submission)).toBe(true);
  });

  it('denies a user whose permission is on some OTHER course', () => {
    expect(r.canReview(userWith('course-B'), submission)).toBe(false);
  });

  it('fails closed when the user or submission is missing', () => {
    expect(r.canReview(null, submission)).toBe(false);
    expect(r.canReview(userWith('course-A'), null)).toBe(false);
  });
});

describe('ltiReview.redirectPath', () => {
  it('targets the feedback PANEL, not the bare embed', () => {
    // The embed shows the work and inline comments but has no comments-to-student
    // form, so a grader arriving from the LMS could see the submission and had no
    // way to respond without leaving for the course dashboard.
    expect(r.redirectPath({ id: 'sub123', lang: 'python3' }))
      .toBe('/lti/review-panel/sub123');
  });
});
