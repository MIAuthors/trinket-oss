// A cookie carrying `Partitioned` (CHIPS) is stored by browsers that block
// third-party cookies — but it is ONLY visible inside the top-level site that
// set it. So the existing session cookie stays as it is (a student who opens
// trinket in a new tab from inside the LMS frame keeps their session wherever
// third-party cookies are allowed), and a partitioned COPY rides alongside it
// for the frames that refuse the first one (#286).
//
// Same name on purpose: Firebase Hosting forwards only `__session` to Cloud
// Run. Where a browser holds both jars it sends both, so the request side
// collapses duplicates before hapi parses them.
const sessionCookie = require('../../../lib/util/sessionCookie');

const SESSION = 'session=Fe26.2**abc; Secure; HttpOnly; SameSite=None; Path=/';

describe('sessionCookie.partitionedCopies', () => {
  it('copies the session cookie under the SAME name with Partitioned appended', () => {
    expect(sessionCookie.partitionedCopies([SESSION], 'session'))
      .toEqual([SESSION + '; Partitioned']);
  });

  it('leaves other cookies alone and matches the NAME, not a prefix', () => {
    const out = sessionCookie.partitionedCopies(
      ['other=1; Path=/', 'sessionx=2; Path=/', SESSION], 'session');
    expect(out).toEqual([SESSION + '; Partitioned']);
  });

  it('does not copy an entry that is already partitioned, nor one whose twin is already there', () => {
    expect(sessionCookie.partitionedCopies([SESSION + '; Partitioned'], 'session')).toEqual([]);
    // hapi can hand the array back through the header setter more than once
    expect(sessionCookie.partitionedCopies([SESSION, SESSION + '; Partitioned'], 'session')).toEqual([]);
  });

  it('copies a cleared cookie too, so logout clears both jars', () => {
    const cleared = 'session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None; Path=/';
    expect(sessionCookie.partitionedCopies([cleared], 'session')).toEqual([cleared + '; Partitioned']);
  });

  it('is empty for no input and accepts a bare string', () => {
    expect(sessionCookie.partitionedCopies(undefined, 'session')).toEqual([]);
    expect(sessionCookie.partitionedCopies('session=x; Path=/', 'session')).toHaveLength(1);
  });
});

describe('sessionCookie.wantsCopy', () => {
  // Was "any navigation into a frame". That is now every response on a Secure
  // deploy — see #314 and the comment on wantsCopy. The frame cases still hold;
  // what changed is that top-level navigations get the copy too, which is what
  // keeps the two jars from drifting apart.
  it('is true for any navigation into a frame — the launch and the pages after it', () => {
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(sessionCookie.wantsCopy({ 'sec-fetch-dest': 'frame' })).toBe(true);
  });

  it('is ALSO true top-level, so a sign-in refreshes both jars (#314)', () => {
    // A login is a top-level navigation. While this returned false there, the
    // login response refreshed only the plain cookie and left the partitioned
    // twin holding its pre-login value.
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' })).toBe(true);
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' })).toBe(true);
    expect(sessionCookie.wantsCopy({})).toBe(true);
    expect(sessionCookie.wantsCopy(undefined)).toBe(true);
  });
});

// The relationship neither half was asserting (#314).
//
// wantsCopy and dedupe were each correct to their own spec, and the integration
// test covered "a frame navigation gets the copy" and "a top-level sign-in sets
// it once". Nothing covered the state every trinket user reaches by opening one
// trinket: a first-party partitioned twin ALREADY EXISTS (trinket embeds itself
// in a same-origin iframe), and then the plain cookie is updated by a login.
//
// dedupe keeps whichever cookie the browser lists first, and browsers order the
// Cookie header by creation time, not by which was updated last. So the twin
// created first wins for the rest of the session — a login that succeeded
// server-side and an anonymous page immediately after.
describe('the two jars cannot drift apart (#314)', () => {
  const SESSION_NAME = 'session';
  const OLD = 'session=Fe26.2**OLD; Secure; HttpOnly; SameSite=None; Path=/';
  const NEW = 'session=Fe26.2**NEW; Secure; HttpOnly; SameSite=None; Path=/';

  // The trigger: a same-origin iframe — trinket embedding trinket — must be a
  // context that gets a copy, which is how the first-party twin appears at all.
  it('a same-origin iframe does get a copy, so the twin is real', () => {
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(sessionCookie.partitionedCopies([OLD], SESSION_NAME)).toEqual([OLD + '; Partitioned']);
  });

  it('a later top-level update copies too, so both jars move together', () => {
    // The login response. Before the fix wantsCopy was false here and only the
    // plain cookie was re-issued.
    const login = { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' };
    expect(sessionCookie.wantsCopy(login)).toBe(true);

    const emitted = [NEW].concat(sessionCookie.partitionedCopies([NEW], SESSION_NAME));
    expect(emitted).toEqual([NEW, NEW + '; Partitioned']);

    // Both jars now hold the NEW value, so whichever one the browser lists
    // first, dedupe hands the session that was just established to yar.
    const asSentOldFirst = 'session=Fe26.2**NEW; session=Fe26.2**NEW';
    const conflicts = [];
    expect(sessionCookie.dedupe(asSentOldFirst, SESSION_NAME, (k, d) => conflicts.push([k, d])))
      .toBe('session=Fe26.2**NEW');
    expect(conflicts, 'identical twins must not even be reported as a conflict').toEqual([]);
  });

  it('REGRESSION: a stale twin listed first would take over the session', () => {
    // What the bug looked like. Kept as the statement of what must not recur:
    // if the jars are ever allowed to diverge, dedupe picks by POSITION and the
    // pre-login value wins.
    const conflicts = [];
    const kept = sessionCookie.dedupe(
      'session=Fe26.2**OLD; session=Fe26.2**NEW', SESSION_NAME,
      (k, d) => conflicts.push([k, d]));

    expect(kept, 'position, not recency — this is why both jars must be written together')
      .toBe('session=Fe26.2**OLD');
    expect(conflicts).toEqual([['Fe26.2**OLD', 'Fe26.2**NEW']]);
  });
});

describe('sessionCookie.dedupe', () => {
  it('keeps the first of two same-named session cookies and reports a differing drop', () => {
    const conflicts = [];
    expect(sessionCookie.dedupe('a=1; session=FIRST; b=2; session=SECOND', 'session',
      (k, d) => conflicts.push([k, d]))).toBe('a=1; session=FIRST; b=2');
    expect(conflicts).toEqual([['FIRST', 'SECOND']]);
  });

  it('drops an identical duplicate silently — the normal two-jar case', () => {
    const conflicts = [];
    expect(sessionCookie.dedupe('session=SAME; session=SAME', 'session', (k, d) => conflicts.push([k, d])))
      .toBe('session=SAME');
    expect(conflicts).toEqual([]);
  });

  it('returns the very same header when there is one or none (no rewrite)', () => {
    const one = 'a=1; session=ONLY; b=2';
    expect(sessionCookie.dedupe(one, 'session')).toBe(one);
    const none = 'a=1; b=2';
    expect(sessionCookie.dedupe(none, 'session')).toBe(none);
    expect(sessionCookie.dedupe(undefined, 'session')).toBeUndefined();
  });

  it('does not confuse look-alike names', () => {
    const h = 'xsession=1; session=A; session_old=2';
    expect(sessionCookie.dedupe(h, 'session')).toBe(h);
  });

  it('works for the Hosting cookie name', () => {
    expect(sessionCookie.dedupe('__session=A; __session=B', '__session')).toBe('__session=A');
  });
});
