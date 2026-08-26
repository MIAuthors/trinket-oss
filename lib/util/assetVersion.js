// A stable, deploy-scoped token for versioned asset URLs.
//
// stringUtils.addPrefix has always stamped `Date.now()` when no prefix is
// configured — evaluated per CALL, so a single page render emits several
// different prefixes (a live deploy served base.css under ...186281 while
// ace.js came back under ...186294), and every reload invents new ones again.
// That makes an asset URL unique per view, which defeats the browser cache and
// would defeat a CDN edge cache too, no matter what Cache-Control says.
//
// The token must therefore change exactly when the assets change: on deploy.
var buildInfo = require('./buildInfo');

// Long enough that a page render costs at most one resolve, short enough that a
// bind-mounted `git pull` rolls asset URLs without waiting for a restart.
var TTL_MS = 30000;

// Pure, so the precedence is testable without a build or a checkout.
function tokenFrom(info, bootMs) {
  var commit = info && info.commit;
  if (commit && commit !== 'unknown') return commit;
  // Dev runs have no build args and no .git. Per-boot is still a world apart
  // from per-render: a reload hits the cache, only a restart rolls it.
  return String(bootMs);
}

// `resolve` and `clock` are injected so tests can move time and count reads.
function create(resolve, clock) {
  var cached = null, checkedAt = 0, permanent = false;
  var boot = clock();

  return {
    token: function () {
      var now = clock();
      if (cached === null || (!permanent && now - checkedAt >= TTL_MS)) {
        var info = resolve();
        cached    = tokenFrom(info, boot);
        checkedAt = now;
        // COMMIT_ID is baked into the image; nothing can change it under a
        // running process, so re-reading it forever would be wasted I/O.
        permanent = !!(info && info.commitSource === 'env');
      }
      return cached;
    }
  };
}

var shared = create(function () { return buildInfo.publicInfo(); }, Date.now);

module.exports = {
  token     : shared.token,
  tokenFrom : tokenFrom,
  create    : create
};
