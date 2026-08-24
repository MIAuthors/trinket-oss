// #176: GET /login returned 500 with "reply.redirect is not a function" when an
// already-authenticated user hit it (bookmark, back button, stale link).
//
// `reply` is not the Hapi toolkit here. lib/util/routeParser.js builds it as a
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

function makeRequest(isAuthenticated, query) {
  const stashed = {};
  return {
    stashed,
    auth  : { isAuthenticated },
    query : query || {},
    yar   : { set: (k, v) => { stashed[k] = v; } },
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

  it('stashes ?next= so the post-login redirect can honour it', () => {
    // The else-branch's only other side effect; auth.js reads it back after
    // the session is established.
    const request = makeRequest(false, { next: '/library/trinkets/abc' });
    pages.login(request, makeReply());
    expect(request.stashed.next).toBe('/library/trinkets/abc');
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

  it('stashes ?next= for after the account is created', () => {
    const request = makeRequest(false, { next: '/course/join/xyz' });
    pages.signup(request, makeReply());
    expect(request.stashed.next).toBe('/course/join/xyz');
  });
});

describe('no controller calls reply.redirect as a property', () => {
  // The bug pattern itself: `reply` is the hapi-16 compatibility shim — a
  // FUNCTION — so `reply.redirect(...)` is a property access on a function
  // object (undefined) and throws at request time, turning a routine page into
  // a 500 (#176). Correct is `reply().redirect(...)`. This fence fails the
  // suite if the pattern ever comes back in any controller.
  it('lib/controllers is free of the reply.redirect( pattern', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../../lib/controllers');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\breply\.redirect\s*\(/.test(line)) offenders.push(f + ':' + (i + 1));
      });
    }
    expect(offenders, 'use reply().redirect(...) — reply is the shim function').toEqual([]);
  });
});
