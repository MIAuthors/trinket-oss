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

  it('tolerates missing input rather than throwing', () => {
    expect(r.parseTarget('')).toBeNull();
    expect(r.parseTarget(undefined)).toBeNull();
    expect(r.parseTarget(null)).toBeNull();
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
