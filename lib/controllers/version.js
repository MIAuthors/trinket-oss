var buildInfo = require('../util/buildInfo'),
    siteAdmin = require('../util/siteAdmin');

// Is this caller a site admin?
//
// Checks the seeded role OR the admin-email allowlist. The allowlist arm is not
// redundant: the 'admin' role is stamped by ensureSeedAdminRole on the Firebase
// and Google-OAuth login paths only — the LOCAL email/password path never calls
// it (see issue #74), so on a Mongo/local-auth deploy hasRole('admin') is false
// for everyone. The allowlist is the same seed source the role comes from, so
// consulting it directly makes the gate work on both auth shapes. Anonymous and
// non-admin callers fail closed either way.
function isSiteAdmin(user) {
  if (!user) return false;
  if (user.hasRole && user.hasRole('admin')) return true;
  return siteAdmin.isAdminEmail(user.email);
}

module.exports = {
  // GET /version — which build is live. Public by design: testers and
  // maintainers need to report/verify the running build without gcloud or ssh.
  // Admins additionally get the infrastructure detail (see buildInfo).
  show: function(request, reply) {
    var body = buildInfo.publicInfo();

    if (isSiteAdmin(request.user)) {
      var extras = buildInfo.adminExtras();
      Object.keys(extras).forEach(function(k) { body[k] = extras[k]; });
    }

    return request.success(body);
  }
};
