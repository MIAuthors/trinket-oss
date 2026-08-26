// The canonical-class redirect must stay on the PUBLIC origin.
//
// Found live on the CDN trial: an LTI student launch (top-level, cookies fine)
// arrived at /lti/launch on the public hostname, got its session cookie, was
// relatively redirected to /{user}/courses/{slug} — and then coursePage's
// canonicalizer 302'd to an ABSOLUTE URL built from request.info.hostname,
// which behind the Hosting rewrite is the backend's own run.app host. The
// browser followed it to an origin where the session cookie does not exist:
// every student landed anonymous, in every browser.
const courses = require('../../../lib/controllers/courses');
const config  = require('config');
// whatever hostname this test env claims — the resolver only honours
// forwarded hosts on the deploy's own allowlist, exactly as in production
const PUBLIC_HOST = config.app.url.hostname;

function fakeReply() {
  const redirects = [];
  const reply = () => ({ redirect: (url) => { redirects.push(url); return { url }; } });
  reply.redirects = redirects;
  return reply;
}

function studentRequest(headers, hostname) {
  return {
    headers,
    info   : { hostname },
    params : { userSlug: 'teacher1', courseSlug: 'test-course' },
    user   : null,                       // anonymous/student: cannot edit -> redirect branch
    pre    : { course: { id: 'c1', recordView: () => Promise.resolve() } },
    success: function () {},
  };
}

describe('coursePage canonical redirect behind a CDN front door', () => {
  it('builds the redirect on the forwarded (public) host, not the backend host', () => {
    const reply = fakeReply();
    courses.coursePage(studentRequest(
      { 'x-forwarded-host': PUBLIC_HOST },
      'trinket-cdntest-abc-uc.a.run.app'
    ), reply);
    expect(reply.redirects.length).toBe(1);
    expect(reply.redirects[0]).toContain(PUBLIC_HOST);
    expect(reply.redirects[0]).not.toContain('run.app');
  });

  it('keeps using the request host when nothing is forwarded', () => {
    const reply = fakeReply();
    courses.coursePage(studentRequest({}, 'localhost'), reply);
    expect(reply.redirects[0]).toContain('localhost');
  });

  it('ignores a forwarded host the deploy does not claim', () => {
    const reply = fakeReply();
    courses.coursePage(studentRequest(
      { 'x-forwarded-host': 'evil.example.com' }, 'backend.internal.host'
    ), reply);
    expect(reply.redirects[0]).toContain('backend.internal.host');
    expect(reply.redirects[0]).not.toContain('evil');
  });
});
