'use strict';

// findUnacceptedByCourse must return the non-accepted invitations on BOTH backends.
// It used `status: { $ne: 'accepted' }`, which on Firestore is a `!=` combined with
// `courseId ==` — that needs a composite index (not deployed) so the query fails and
// the instructor's pending-students list comes back empty on reload (MIAuthors #11).
// The fix queries by courseId only and filters status in app code (no $ne / no index).
const CourseInvitation = require('../../../lib/models/courseInvitation');

describe('CourseInvitation.findUnacceptedByCourse', () => {
  let course, otherCourse;

  beforeEach(async () => {
    const owner = new User({ email: 'owner-inv@x.edu', username: 'owner-inv', fullname: 'Owner' });
    await owner.save();
    course      = new Course({ name: 'roster course', _owner: owner, ownerSlug: owner.username });
    otherCourse = new Course({ name: 'other course',  _owner: owner, ownerSlug: owner.username });
    await course.save();
    await otherCourse.save();
  });

  function seed(courseId, email, status, token) {
    return new CourseInvitation({ courseId: courseId, email: email, status: status, token: token }).save();
  }

  it('returns pending/sent invitations, excludes accepted and other courses', async () => {
    await seed(course.id,      'a@x.edu', 'pending',  't1');
    await seed(course.id,      'b@x.edu', 'sent',     't2');
    await seed(course.id,      'c@x.edu', 'accepted', 't3');   // must be excluded
    await seed(otherCourse.id, 'd@x.edu', 'pending',  't4');   // different course — must not appear

    const result = await CourseInvitation.findUnacceptedByCourse(course);
    const emails = result.map(function (i) { return i.email; }).sort();
    expect(emails).toEqual(['a@x.edu', 'b@x.edu']);
  });
});
