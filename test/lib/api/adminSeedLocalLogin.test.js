const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const User     = require('../../../lib/models/user');

// Issue #74: on a Mongo / self-host deploy there is no way to bootstrap admin
// access. The site 'admin' role is stamped from the ADMIN_EMAILS allowlist by
// siteAdmin.ensureSeedAdminRole, which the Firebase and Google-OAuth login paths
// both call (lib/controllers/auth.js) — but the LOCAL email/password path never
// did. On a deploy that uses local auth, that is the ONLY login path, so
// hasRole('admin') stayed false for everyone: /admin was unreachable and
// dynamically-registered LTI platforms could not be approved out of `pending`
// (the reported workaround was editing status directly in the database).
//
// The allowlist is a SEED, not a per-request gate — every gate downstream reads
// the role — so the seeding has to happen at login or it never happens at all.
describe('local login seeds the site admin role (#74)', () => {
  let savedAdminEmails;

  beforeEach(() => {
    flow.cookies = {};
    savedAdminEmails = process.env.ADMIN_EMAILS;
  });

  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  async function findUser(email) {
    return new Promise((resolve, reject) => {
      User.findByLogin(email, (err, doc) => (err ? reject(err) : resolve(doc)));
    });
  }

  it("stamps 'admin' on a user whose email is in ADMIN_EMAILS", async () => {
    process.env.ADMIN_EMAILS = JSON.stringify([defaults.user.email]);

    await flow.switchUser('user');           // creates + logs in via POST /login

    const user = await findUser(defaults.user.email);
    expect(user, 'the login should have created the user').toBeTruthy();
    expect(user.hasRole('admin'), 'ADMIN_EMAILS member must hold the admin role after local login').toBe(true);
  });

  it('leaves a user who is NOT on the allowlist unprivileged', async () => {
    process.env.ADMIN_EMAILS = JSON.stringify(['someone-else@example.com']);

    await flow.switchUser('user');

    const user = await findUser(defaults.user.email);
    expect(user.hasRole('admin'), 'non-listed users must not be stamped admin').toBe(false);
  });

  it('grants access to /admin after seeding, not just the role', async () => {
    // The role is only useful if the gate downstream honours it — this is the
    // behaviour the issue actually reports as broken (admin pages unreachable).
    process.env.ADMIN_EMAILS = JSON.stringify([defaults.user.email]);

    await flow.switchUser('user');
    await flow.admin();

    expect(flow.lastResponse.statusCode, '/admin should be reachable by a seeded admin').toEqual(200);
  });

  it('renders the login page for a non-admin, not the generic error page', async () => {
    // Sub-bug 2 of #74: GET /admin declares `fail: { html: 'login.html' }`, but a
    // PRE-handler that throws (isAdmin -> Boom.forbidden) never reached that, so
    // the reporter saw "Something went wrong" — reads as a broken site rather
    // than "you need to sign in". The old test only checked the status code, so
    // it passed while the page was wrong.
    delete process.env.ADMIN_EMAILS;
    await flow.switchUser('user');
    const res = await flow.get('/admin');
    const body = String(res.payload || res.body || '');

    expect(res.statusCode, 'still a 403 — only the rendered page changes').toBe(403);
    expect(body, 'must not fall through to the generic error page').not.toMatch(/Something went wrong/i);
  });
});
