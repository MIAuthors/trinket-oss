'use strict';

// #137: a course OWNER could not grant the Associate role on their own course.
// The dropdown row was gated on `isAdmin` — which is not a course role at all,
// but site-wide admin injected through ng-init — so the one role that grants
// make-course-copy was unreachable for the people who own the course.
//
// It was also inconsistent: `course-admin`, grantable by any owner from the
// same menu, is STRICTLY STRONGER than `course-associate`. And the server never
// enforced it (course.updateRoles checks only manage-course-access), so the gate
// hid a capability the API already allowed.
//
// Static source assertions, matching course-editor-menu.test.js — there is no
// Angular/DOM harness in this repo.

const fs   = require('fs');
const path = require('path');

const ROOT_JS = path.join(__dirname, '../../public/js/courseEditor/controllers/root.js');
const PARTIAL = path.join(__dirname, '../../public/partials/course_editor.html');

const COURSE  = path.join(__dirname, '../../lib/controllers/course.js');

const js    = fs.readFileSync(ROOT_JS, 'utf8');
const html  = fs.readFileSync(PARTIAL, 'utf8');


// The assignment, without its comment block.
function assignment() {
  const m = js.match(/this\.\$scope\.canAssignAssocRole\s*=[^;]*;/);
  expect(m).not.toBeNull();
  return m[0];
}

describe('Associate role gating (#137)', () => {
  it('gates Associate on the course permission', () => {
    expect(assignment()).toContain('canManageAccess');
  });

  it('no longer requires site-wide admin', () => {
    // The regression this exists to catch: re-introducing `isAdmin` here would
    // silently hide the row again for every non-site-admin course owner.
    expect(assignment()).not.toContain('isAdmin');
  });

  it('matches how its sibling roles are gated', () => {
    // Student / Collaborator / Admin carry no ng-show at all in the dropdown;
    // Associate should be reachable on the same permission that renders them.
    const menu = html.slice(html.indexOf('updateUserRole(user, \'student\')'),
                            html.indexOf('updateUserRole(user, \'admin\')'));
    expect(menu).toContain("updateUserRole(user, 'associate')");
  });
});

describe('why the old gate was inconsistent', () => {
  // Guards the PREMISE of the fix rather than the fix itself. Read from the
  // real role table, not scraped source, so it tracks the definitions.
  const roleTable = require('../../lib/models/roles.js');

  it('an owner can already grant a role that outranks Associate', () => {
    return Promise.all([
      roleTable.getPermissions('course-associate'),
      roleTable.getPermissions('course-admin')
    ]).then(([assoc, admin]) => {
      // Associate's only capability beyond viewing is taking a copy — which is
      // the whole of what the hidden row was withholding.
      expect(assoc).toContain('make-course-copy');

      // Admin, grantable by any owner from the same dropdown, carries the
      // course-management permissions associate does not. Withholding the
      // weaker role while offering the stronger one is the inconsistency.
      expect(admin).toContain('manage-course-access');
      expect(admin).toContain('manage-course-content');
      expect(admin).not.toContain('delete-course');   // owner-only, for contrast
    });
  });
});

describe('the server side this relies on', () => {
  it('updateRoles authorises on manage-course-access alone', () => {
    // If this ever tightens to also require site admin, the UI gate would need
    // to come back — the fix assumes the API already accepts `associate` from a
    // course owner.
    const src = fs.readFileSync(COURSE, 'utf8');
    const at  = src.indexOf('updateRoles :');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    expect(body).toContain('hasPermission("manage-course-access"');
  });
});
