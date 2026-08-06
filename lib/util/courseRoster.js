'use strict';

// Add a mixed "Add Students" roster to a course, doing the right thing per row
// (MIAuthors, Aaron's request): rows that match an EXISTING Trinket account are
// enrolled immediately (like the "Add Trinket User" button), while rows with no
// account become pending invitations.
//
// Why invitations for new emails still work without a mailer (mandi/uindy):
// the invitation record IS the enrollment mechanism — courseEnrollment
// .acceptPendingInvitations matches it by email on the invitee's next sign-in
// and enrolls them then. The email is only a notification, sent by the caller
// (sendInvitations) when the mailer is configured. See [[courseEnrollment]].

var User             = require('../models/user');
var CourseInvitation = require('../models/courseInvitation');

var CHUNK = 30; // keep $in queries under backend (Firestore) limits

// One batched lookup of existing accounts by email, chunked and concatenated —
// avoids an N+1 per-row query on large rosters (see CLAUDE.md Firestore notes).
function findUsersByEmails(emails) {
  var chunks = [];
  for (var i = 0; i < emails.length; i += CHUNK) {
    chunks.push(emails.slice(i, i + CHUNK));
  }
  return chunks.reduce(function (chain, chunk) {
    return chain.then(function (acc) {
      return User.find({ email: { $in: chunk } }).exec()
        .then(function (found) { return acc.concat(found || []); });
    });
  }, Promise.resolve([]));
}

// Returns { enrolled: [<course-user objects>], invitations: [<invitation docs>] }.
// enrolled excludes accounts that were already on the roster (addUser
// short-circuits via alreadyListed), so the count reflects only NEW enrollments.
async function addRoster(students, course) {
  // Normalize + dedupe by lowercased email, keeping last-seen name — same shape
  // CourseInvitation.addList expects and produces.
  students = (students || []).map(function (s) {
    return typeof s === 'string'
      ? { email: s.toLowerCase(), name: '' }
      : { email: (s.email || '').toLowerCase(), name: s.name || '' };
  });
  var nameByEmail = {};
  students.forEach(function (s) { if (s.email) { nameByEmail[s.email] = s.name; } });
  var emails = Object.keys(nameByEmail);

  if (!emails.length) {
    return { enrolled: [], invitations: [] };
  }

  var existing = await findUsersByEmails(emails);
  var userByEmail = {};
  existing.forEach(function (u) { userByEmail[(u.email || '').toLowerCase()] = u; });

  // Enroll existing accounts directly. addUser is an atomic $push, so a
  // sequential loop over the same course is race-safe (no lost updates).
  var enrolled = [];
  for (var i = 0; i < emails.length; i++) {
    var user = userByEmail[emails[i]];
    if (!user) { continue; }
    var result = await course.addUser(user, ['course-student']);
    if (result && result.success && result.user) {
      enrolled.push(result.user);
    }
  }

  // Everything without an account becomes an invitation (auto-accepted on signin).
  var newStudents = emails
    .filter(function (email) { return !userByEmail[email]; })
    .map(function (email) { return { email: email, name: nameByEmail[email] }; });

  // addList upserts its whole batch via Promise.all (unbounded concurrency).
  // Feed it in bounded chunks so a large roster can't burst past backend write
  // limits — a backstop even though the client chunks its POSTs too.
  var invitations = [];
  for (var j = 0; j < newStudents.length; j += CHUNK) {
    var slice = newStudents.slice(j, j + CHUNK);
    var made = await CourseInvitation.addList(slice, course);
    invitations = invitations.concat(made || []);
  }

  return { enrolled: enrolled, invitations: invitations };
}

module.exports = { addRoster: addRoster };
