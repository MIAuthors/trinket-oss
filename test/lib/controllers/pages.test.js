// #176: GET /login returned 500 with "reply.redirect is not a function" when an
// already-authenticated user hit it (bookmark, back button, stale link).
//
// `reply` is not the Hapi toolkit here. routeParser.js:426 builds it as a
// hapi-16 style compatibility SHIM — a function that returns a chainable
// response builder. So `reply()` is correct and `reply.redirect` is a property
// access on a function object, which is undefined. Every other controller
// (admin.js, courses.js, classes.js) already calls `reply().redirect(...)`.
const pages = require('../../../lib/controllers/pages');

// Mirrors the shim's shape: callable, returning something chainable.
function makeReply() {
  const redirects = [];
  const reply = () => ({ redirect: (url) => { redirects.push(url); return { url }; } });
  reply.redirects = redirects;
  return reply;
}

function makeRequest(isAuthenticated) {
  return {
    auth  : { isAuthenticated },
    query : {},
    yar   : { set: () => {} },
    success : function (ctx) { this.succeeded = ctx || true; },
  };
}

describe('pages.login', () => {
  it('redirects an already-authenticated visitor to /home', () => {
    const reply = makeReply();
    const request = makeRequest(true);
    expect(() => pages.login(request, reply)).not.toThrow();
    expect(reply.redirects).toEqual(['/home']);
  });

  it('renders the login page for an anonymous visitor', () => {
    const reply = makeReply();
    const request = makeRequest(false);
    pages.login(request, reply);
    expect(reply.redirects).toEqual([]);
    expect(request.succeeded).toBeTruthy();
  });
});

describe('pages.signup', () => {
  it('redirects an already-authenticated visitor to /welcome', () => {
    // Same defect, same file — the 2026-08-18 /signup 5xx in the issue is very
    // likely this.
    const reply = makeReply();
    const request = makeRequest(true);
    expect(() => pages.signup(request, reply)).not.toThrow();
    expect(reply.redirects).toEqual(['/welcome']);
  });

  it('renders the signup page for an anonymous visitor', () => {
    const reply = makeReply();
    const request = makeRequest(false);
    pages.signup(request, reply);
    expect(reply.redirects).toEqual([]);
  });
});
