// Shared naming for deploy-test fixtures.
//
// The sweeper (scripts/smoke-cleanup.js) deletes by this convention, so the
// convention lives in ONE place: if a spec and the sweeper ever disagree, the
// sweeper either misses orphans or deletes something it shouldn't.
//
// Fixture policy (see docs/DEPLOY-TESTING.md):
//   identity  — standing, created and approved ONCE per deploy
//   data      — ephemeral, created and destroyed per run, named from here
const PREFIX = 'smoke-';

module.exports = {
  PREFIX,

  // A per-run id, so parallel or abandoned runs cannot collide.
  runId() {
    return PREFIX + Math.random().toString(36).slice(2, 8);
  },

  // Anything the sweeper is allowed to remove must match this.
  isFixtureName(name) {
    return typeof name === 'string' && name.indexOf(PREFIX) === 0;
  },

  courseName(runId) {
    return runId + ' course';
  },
};
