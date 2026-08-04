'use strict';

// Accept a user's pending course invitations and enroll them. Extracted from the
// auth session handler so it can run on EVERY login (new AND existing users) — the
// enroll loop used to live only in the new-signup branch, so an existing Trinket
// user added via "Add Students" never got enrolled (MIAuthors #10). Idempotent:
// only pending/sent invitations are processed, and course.addUser short-circuits
// when the user is already enrolled.

var CourseInvitation = require('../models/courseInvitation');
var Course           = require('../models/course');

// Returns { name, ownerSlug, slug } of the first course the user was enrolled into
// (for a login flash), or null. A failure on one invitation is logged and skipped
// so it never blocks login or the remaining invitations.
async function acceptPendingInvitations(user) {
  var email = (user && user.email || '').toLowerCase();
  if (!email) return null;

  // Query by email only (equality) and filter status in app — avoids a Firestore
  // composite-index requirement on (email, status), same reasoning as #11.
  var all = await CourseInvitation.find({ email: email });
  var pending = all.filter(function(inv) {
    return inv.status === 'pending' || inv.status === 'sent';
  });

  var firstCourse = null;
  for (var i = 0; i < pending.length; i++) {
    var inv = pending[i];
    try {
      var course = await Course.findById(inv.courseId.toString());
      if (course) {
        await course.addUser(user, ['course-student']);
        if (!firstCourse) {
          firstCourse = { name: course.name, ownerSlug: course.ownerSlug, slug: course.slug };
        }
      }
      inv.status = 'accepted';
      await inv.save();
    } catch (err) {
      console.error('acceptPendingInvitations: failed for invitation', inv && inv.id, err && err.message);
    }
  }
  return firstCourse;
}

module.exports = { acceptPendingInvitations: acceptPendingInvitations };
