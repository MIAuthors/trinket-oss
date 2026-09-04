'use strict';

// A course member whose embedded record has no email crashed Add Students for
// the whole course: addList built its dedupe set with
//
//   course.users.map(user => user.email.toLowerCase())
//
// which throws TypeError on the first member without one. The throw reaches
// `.catch(err => reply(err))` in sendInvitations, so the instructor gets a bare
// 500 — and because production logs request errors nowhere (debug:false plus an
// isDev-gated listener), the app log shows a normal handler completion with a
// timing and no error at all.
//
// Reported on the picup VPS: 2 occurrences 2026-08-27, 4 on the 28th, 10 on the
// 29th, each cluster on a different course, one of them 9 retries in 14 minutes
// — an instructor re-trying a roster upload that could never succeed.
//
// A member with no email cannot match any invited address, so the correct
// behaviour is to leave them out of the dedupe set rather than to throw.
const CourseInvitation = require('../../../lib/models/courseInvitation');

describe('CourseInvitation.addList with an email-less course member', () => {
  let course, owner;

  beforeEach(async () => {
    owner = new User({ email: 'owner-addlist@x.edu', username: 'owner-addlist', fullname: 'Owner' });
    await owner.save();
    course = new Course({ name: 'addList course', _owner: owner, ownerSlug: owner.username });
    await course.save();
  });

  it('invites a new student even when a member has no email', async () => {
    // email is optional on the embedded member (course.js), so this is exactly
    // the shape addUser writes when the User it copies from has none.
    course.users.push({ userId: owner._id, username: 'ghost', displayName: 'Ghost' });
    await course.save();

    const made = await CourseInvitation.addList([{ email: 'New@X.edu', name: 'New' }], course);

    expect(made.length, 'the invitation should still be created').toBe(1);
    expect(made[0].email).toBe('new@x.edu');
  });

  it('still dedupes against members that DO have an email', async () => {
    course.users.push({ userId: owner._id, username: 'real', email: 'Enrolled@X.edu' });
    await course.save();

    const made = await CourseInvitation.addList(
      [{ email: 'enrolled@x.edu', name: 'Already In' }, { email: 'fresh@x.edu', name: 'Fresh' }],
      course
    );

    const emails = made.map((i) => i.email);
    expect(emails, 'an already-enrolled member must not be re-invited').toEqual(['fresh@x.edu']);
  });
});
