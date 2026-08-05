'use strict';

// acceptPendingInvitations enrolls a user into every course they have a pending/sent
// invitation for, on ANY login. This is the fix for MIAuthors #10: the enroll loop
// used to live inside the new-signup branch of the auth session handler, so an
// EXISTING Trinket user added via "Add Students" never got enrolled (only brand-new
// signups did). Extracted here so it runs for all users and is unit-testable.
const courseEnrollment = require('../../../lib/util/courseEnrollment');
const CourseInvitation = require('../../../lib/models/courseInvitation');

describe('courseEnrollment.acceptPendingInvitations', () => {
  let owner, student, course;

  beforeEach(async () => {
    owner = new User({ email: 'owner-enr@x.edu', username: 'owner-enr', fullname: 'Owner' });
    await owner.save();
    student = new User({ email: 'student-enr@x.edu', username: 'student-enr', fullname: 'Student' });
    await student.save();
    course = new Course({ name: 'enroll course', _owner: owner, ownerSlug: owner.username });
    await course.save();
    await course.addUser(owner, ['course-owner']);
  });

  it('enrolls an existing user with a pending invitation and marks it accepted', async () => {
    await new CourseInvitation({ courseId: course.id, email: student.email, status: 'pending', token: 'tok-enr' }).save();

    const flash = await courseEnrollment.acceptPendingInvitations(student);

    const reloaded = await Course.findById(course.id);
    const memberEmails = (reloaded.users || []).map(function (u) { return u.email; });
    expect(memberEmails).toContain(student.email);          // now enrolled

    const stillUnaccepted = await CourseInvitation.findUnacceptedByCourse(course);
    expect(stillUnaccepted.map(function (i) { return i.email; })).not.toContain(student.email); // invitation accepted

    expect(flash && flash.slug).toBe(course.slug);          // flash points at the course
  });

  it('returns null and changes nothing when there are no pending invitations', async () => {
    const flash = await courseEnrollment.acceptPendingInvitations(student);
    expect(flash).toBeNull();
    const reloaded = await Course.findById(course.id);
    const memberEmails = (reloaded.users || []).map(function (u) { return u.email; });
    expect(memberEmails).not.toContain(student.email);
  });
});
