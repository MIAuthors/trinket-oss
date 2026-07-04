// Unit tests for instructor authorization at signup (gcr-only feature).
//
// Uses the instructorAuth._setDatastore() seam to fake the cross-project
// `instructormi` allowlist, so these run with NO GCP credentials and NO network.
// The shared harness (test/helpers/vitest-setup.cjs) boots the app in beforeAll,
// which registers the CourseInvitation global model that isApprovedToSignup()
// consults on its non-instructor branch.

const instructorAuth = require('../../../lib/util/instructorAuth');

// Minimal fake of the @google-cloud/datastore client surface that
// isApprovedInstructor() exercises:
//   createQuery(kind).filter(field, op, value).filter(...).limit(n)
//   runQuery(query) -> Promise<[entities, info]>
// A query "matches" when it filters authorized === true AND its email field
// (emailOfficial OR emailSignin — the code runs one of each) holds a value in
// the seeded authorized set. Everything is lower-cased to mirror the module,
// which queries with email.toLowerCase().
function fakeInstructorDatastore(authorizedEmails) {
  const authorized = new Set(authorizedEmails.map((e) => e.toLowerCase()));
  return {
    createQuery(kind) {
      const q = { kind, _filters: {} };
      q.filter = (field, _op, value) => { q._filters[field] = value; return q; };
      q.limit = () => q;
      return q;
    },
    runQuery(q) {
      const emailValue = q._filters.emailOfficial ?? q._filters.emailSignin;
      const authorizedFilter = q._filters.authorized === true;
      const hit = authorizedFilter && emailValue &&
        authorized.has(String(emailValue).toLowerCase());
      return Promise.resolve([hit ? [{ emailOfficial: emailValue, authorized: true }] : [], {}]);
    },
  };
}

describe('instructorAuth.isApprovedToSignup', () => {
  afterEach(() => {
    // Reset the injected datastore (also clears the module's 5-min cache).
    instructorAuth._setDatastore(null);
  });

  it('approves an authorized instructor AND sets isInstructor', async () => {
    instructorAuth._setDatastore(fakeInstructorDatastore(['prof@example.test']));
    const result = await instructorAuth.isApprovedToSignup('prof@example.test');
    expect(result).toEqual({ approved: true, isInstructor: true });
  });

  it('matches on emailSignin too, case-insensitively', async () => {
    instructorAuth._setDatastore(fakeInstructorDatastore(['signin@example.test']));
    const result = await instructorAuth.isApprovedToSignup('SignIn@Example.Test');
    expect(result).toEqual({ approved: true, isInstructor: true });
  });

  it('rejects an unknown email with no invitation', async () => {
    // Datastore enabled but empty: the lookup runs and finds nothing, and there
    // is no pending CourseInvitation in the (empty) test DB.
    instructorAuth._setDatastore(fakeInstructorDatastore([]));
    const result = await instructorAuth.isApprovedToSignup('stranger@example.test');
    expect(result).toEqual({ approved: false, isInstructor: false });
  });
});

// The healing seam: isInstructor is written only at Firebase signup, so accounts
// created via the Google/LTI/legacy paths — or authorized AFTER signup — stay
// false forever (re-login never re-checks). ensureInstructorFlag re-evaluates an
// existing user against the authorized allowlist and stamps the flag, mirroring
// siteAdmin.ensureSeedAdminRole. It is wired at both post-login seams
// (auth.js firebase + google) so both doors, and existing accounts, self-heal.
describe('instructorAuth.ensureInstructorFlag', () => {
  afterEach(() => { instructorAuth._setDatastore(null); });

  async function makeUser(overrides) {
    const rand = Math.random().toString(36).slice(2);
    const user = new User({
      fullname: 'Flow Test',
      username: 'flow_' + rand,
      email: 'flow_' + rand + '@example.test',
      source: 'google',
      ...overrides,
    });
    await user.save();
    return user;
  }

  it('flips an authorized instructor from false → true and persists it', async () => {
    const user = await makeUser({ isInstructor: false });
    instructorAuth._setDatastore(fakeInstructorDatastore([user.email]));

    await instructorAuth.ensureInstructorFlag(user);

    expect(user.isInstructor).toBe(true);
    const reloaded = await User.findById(user.id);
    expect(reloaded.isInstructor).toBe(true);
  });

  it('leaves a non-authorized user false', async () => {
    const user = await makeUser({ isInstructor: false });
    instructorAuth._setDatastore(fakeInstructorDatastore([])); // enabled, no match

    await instructorAuth.ensureInstructorFlag(user);

    expect(user.isInstructor).toBeFalsy();
    const reloaded = await User.findById(user.id);
    expect(reloaded.isInstructor).toBeFalsy();
  });

  it('is a no-op for an already-instructor user (skips the lookup)', async () => {
    const user = await makeUser({ isInstructor: true });
    let queried = false;
    instructorAuth._setDatastore({
      createQuery() { return { filter() { return this; }, limit() { return this; } }; },
      runQuery() { queried = true; return Promise.resolve([[], {}]); },
    });

    await instructorAuth.ensureInstructorFlag(user);

    expect(user.isInstructor).toBe(true);
    expect(queried).toBe(false); // short-circuits before consulting the datastore
  });

  it('safely no-ops on a null user', async () => {
    await expect(instructorAuth.ensureInstructorFlag(null)).resolves.toBeFalsy();
  });
});
