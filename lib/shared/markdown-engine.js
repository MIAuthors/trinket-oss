// Single source of truth for which markdown engine a course uses.
// Absent/unknown => 'legacy' (existing courses are untouched by deploy alone).
function engineFor(course) {
  var gs = course && course.globalSettings;
  if (!gs && course && typeof course.toObject === 'function') {
    gs = course.toObject().globalSettings;
  }
  return gs && gs.markdownEngine === 'modern' ? 'modern' : 'legacy';
}
module.exports = { engineFor: engineFor };
