'use strict';

// courseRoster.addRoster splits a mixed "Add Students" roster into two buckets and
// does the right thing for each (Aaron's request): rows that match an EXISTING
// Trinket account are enrolled immediately (like the "Add Trinket User" button),
// while rows with no account become pending invitations (which auto-accept on the
// invitee's next sign-in — the enrollment mechanism even when email is disabled,
// as on mandi/uindy). Email is only a notification and is the caller's concern.
const courseRoster     = require('../../../lib/util/courseRoster');
const CourseInvitation = require('../../../lib/models/courseInvitation');

describe('courseRoster.addRoster', () => {
  let owner, existing, course;

  beforeEach(async () => {
    owner = new User({ email: 'owner-ros@x.edu', username: 'owner-ros', fullname: 'Owner' });
    await owner.save();
    existing = new User({ email: 'existing-ros@x.edu', username: 'existing-ros', fullname: 'Existing Student' });
    await existing.save();
    course = new Course({ name: 'roster course', _owner: owner, ownerSlug: owner.username });
    await course.save();
    await course.addUser(owner, ['course-owner']);
  });

  it('enrolls an existing account immediately and invites a new email', async () => {
    const result = await courseRoster.addRoster([
      { email: 'existing-ros@x.edu', name: 'Existing Student' },
      { email: 'newcomer-ros@x.edu', name: 'New Comer' }
    ], course);

    // existing account is in the enrolled bucket AND on the course roster now
    expect(result.enrolled.map(function (u) { return u.email; })).toContain('existing-ros@x.edu');
    const reloaded = await Course.findById(course.id);
    expect((reloaded.users || []).map(function (u) { return u.email; })).toContain('existing-ros@x.edu');

    // new email is an invitation, NOT enrolled, and no user doc was created for it
    expect(result.invitations.map(function (i) { return i.email; })).toContain('newcomer-ros@x.edu');
    expect(result.enrolled.map(function (u) { return u.email; })).not.toContain('newcomer-ros@x.edu');
    const inv = await CourseInvitation.findUnacceptedByCourse(course);
    expect(inv.map(function (i) { return i.email; })).toContain('newcomer-ros@x.edu');
  });

  it('normalizes case, dedupes, and never creates an invitation for an existing account', async () => {
    const result = await courseRoster.addRoster([
      { email: 'EXISTING-ros@x.edu', name: 'Dup One' },
      { email: 'existing-ros@x.edu', name: 'Dup Two' }
    ], course);

    expect(result.enrolled).toHaveLength(1);
    expect(result.invitations).toHaveLength(0);   // existing account never becomes an invitation
  });

  it('is idempotent — re-adding an already-enrolled account enrolls no one new', async () => {
    await courseRoster.addRoster([{ email: 'existing-ros@x.edu' }], course);
    const second = await courseRoster.addRoster([{ email: 'existing-ros@x.edu' }], course);

    expect(second.enrolled).toHaveLength(0);       // addUser short-circuits (alreadyListed)
    const reloaded = await Course.findById(course.id);
    const count = (reloaded.users || []).filter(function (u) { return u.email === 'existing-ros@x.edu'; }).length;
    expect(count).toBe(1);                          // not double-listed
  });

  it('returns empty buckets for an empty roster', async () => {
    const result = await courseRoster.addRoster([], course);
    expect(result).toEqual({ enrolled: [], invitations: [] });
  });

  it('invites every new email across the chunk boundary (bounded fan-out)', async () => {
    // 70 new emails > CHUNK (30) — exercises the sequential chunk loop so we
    // prove none are dropped when the roster exceeds one batch.
    const roster = [];
    for (let i = 0; i < 70; i++) { roster.push({ email: `bulk-${i}-ros@x.edu`, name: `S${i}` }); }

    const result = await courseRoster.addRoster(roster, course);

    expect(result.invitations).toHaveLength(70);
    const inv = await CourseInvitation.findUnacceptedByCourse(course);
    expect(inv.filter(function (i) { return /^bulk-\d+-ros@x\.edu$/.test(i.email); })).toHaveLength(70);
  });
});
