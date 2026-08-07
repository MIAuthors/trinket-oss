// Build/deploy identity for the /version endpoint.
//
// There is otherwise NO way to tell which build a running deploy is serving:
// Cloud Run revisions don't carry the source SHA, and confirming a deploy meant
// inferring it from a build timestamp (or ssh-ing to the box). The Dockerfile
// has long declared `ARG COMMIT_ID` but nothing consumed it and no build passed
// it, so it stamped nothing. These values come from build args promoted to ENV
// at image build time (see Dockerfile / deploy-cloudrun.sh / docker-compose).
//
// Split by audience, deliberately:
//   publicInfo() — identity only: which code, built when, which deploy. Safe to
//     serve unauthenticated; the repo is public, so a SHA reveals nothing the
//     source doesn't already.
//   adminExtras() — infrastructure profile (db backend, uptime). Withheld from
//     anonymous callers: backend tells an attacker which query/injection
//     techniques apply, and uptime exposes restart/deploy cadence. Neither helps
//     the people this endpoint is for (testers reporting "which build am I on?").
var config = require('config'),
    fs     = require('fs'),
    path   = require('path');

var UNKNOWN = 'unknown';

function env(name) {
  var v = process.env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

// build-info.json is written by scripts/build-info.sh immediately before the
// image is built, and baked in by `COPY . .`. Read once and cached: it cannot
// change for the life of the process. Absent (e.g. bare `node app.js` in dev)
// is normal — every field then reports 'unknown'.
var fileInfo;
function fromFile(key) {
  if (fileInfo === undefined) {
    try {
      fileInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '../../build-info.json'), 'utf8'));
    } catch (e) {
      fileInfo = null;
    }
  }
  return (fileInfo && typeof fileInfo[key] === 'string' && fileInfo[key].trim()) ? fileInfo[key].trim() : null;
}

function packageVersion() {
  try { return require('../../package.json').version || UNKNOWN; }
  catch (e) { return UNKNOWN; }
}

// Identity of the running build. Every field degrades to 'unknown' rather than
// throwing, so a stack built without the build args still serves a valid body.
function publicInfo() {
  // Env wins over the baked file so a running container can be corrected
  // without a rebuild; the file is the normal source.
  var full = env('COMMIT_ID') || fromFile('commit');
  return {
    commit     : full ? full.substring(0, 7) : UNKNOWN,
    commitFull : full || UNKNOWN,
    branch     : env('GIT_BRANCH') || fromFile('branch') || UNKNOWN,
    builtAt    : env('BUILD_TIME') || fromFile('builtAt') || UNKNOWN,
    deploy     : env('TRINKET_DEPLOY') || 'default',
    version    : packageVersion(),
    nodeEnv    : process.env.NODE_ENV || 'development'
  };
}

// Diagnostic detail, admin-only (see note above).
function adminExtras() {
  return {
    backend : (config.db && config.db.backend) || 'mongoose',
    uptime  : Math.round(process.uptime())
  };
}

module.exports = {
  publicInfo  : publicInfo,
  adminExtras : adminExtras
};
