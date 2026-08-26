'use strict';
// The "Connect LMS" nav link must agree with the gate on /lti/connect. Same
// contract as canImport (issue #6): a link that 403s is bad, but a hidden link
// to a page the user IS allowed to use is worse — the feature becomes
// discoverable only by knowing the URL.
//
// The route gate (helpers.canInitiateLtiRegistration) is async because the
// instructormi profile queries Datastore. The nav renders synchronously, so the
// seam also exposes a sync best-effort `mayConnectLms` for display only; the
// route stays authoritative.
const authorityDefault = require('../../../lib/util/ltiInstructorAuthority-default');
const helpers          = require('../../../lib/util/helpers');

function user(email, roles) {
  return { email: email, hasRole: function (r) { return (roles || []).indexOf(r) >= 0; } };
}

describe('Connect-LMS link visibility (default authority)', () => {
  let prev;
  beforeEach(() => { prev = process.env.LTI_INSTRUCTOR_EMAILS; });
  afterEach(() => {
    if (prev === undefined) delete process.env.LTI_INSTRUCTOR_EMAILS;
    else process.env.LTI_INSTRUCTOR_EMAILS = prev;
  });

  it('shows the link to an allowlisted instructor', () => {
    process.env.LTI_INSTRUCTOR_EMAILS = '["teacher@example.edu"]';
    expect(authorityDefault.mayConnectLms(user('teacher@example.edu'))).toBe(true);
  });

  it('hides it from an email that is not on the list', () => {
    process.env.LTI_INSTRUCTOR_EMAILS = '["teacher@example.edu"]';
    expect(authorityDefault.mayConnectLms(user('someone-else@example.edu'))).toBe(false);
  });

  it('matches case-insensitively, as the route gate does', () => {
    process.env.LTI_INSTRUCTOR_EMAILS = '["teacher@example.edu"]';
    expect(authorityDefault.mayConnectLms(user('Teacher@Example.EDU'))).toBe(true);
  });

  it('fails closed on a trust-the-platform deploy with no list configured', () => {
    delete process.env.LTI_INSTRUCTOR_EMAILS;
    expect(authorityDefault.mayConnectLms(user('anyone@example.edu'))).toBe(false);
  });
});

describe('helpers.userCanConnectLms', () => {
  it('always shows the link to a site admin', () => {
    delete process.env.LTI_INSTRUCTOR_EMAILS;
    expect(helpers.userCanConnectLms(user('admin@example.edu', ['admin']))).toBe(true);
  });

  it('is false for anonymous visitors', () => {
    expect(helpers.userCanConnectLms(null)).toBe(false);
  });

  it('is false for a signed-in user with no instructor authority', () => {
    delete process.env.LTI_INSTRUCTOR_EMAILS;
    expect(helpers.userCanConnectLms(user('student@example.edu'))).toBe(false);
  });
});
