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

// The commit the running CODE is at, when the app is served out of a git
// checkout. This is not the same question as "which image is this?": a compose
// deploy BIND-MOUNTS the checkout over the image
// (docker-compose.yml: `- .:/usr/local/node/trinket`), so the code being served
// is whatever the host checkout is at *right now*, while COMMIT_ID and
// build-info.json stay frozen at the last image build. Reporting the build
// stamp there isn't merely incomplete, it's wrong — trial-merge served 6971ae4
// while /version claimed e6ebc9a, and build-info.json is itself inside the
// bind mount, so it goes stale with everything else.
//
// Read .git directly instead of shelling out to `git`: no subprocess on a
// public endpoint, and no dependency on git existing in the image (it doesn't).
// Deliberately NOT cached — a bind-mounted checkout moves under a running
// process on every `git pull`, which is the entire case this exists for.
function readTrimmed(p) {
  try {
    var s = fs.readFileSync(p, 'utf8');
    return (s && s.trim()) ? s.trim() : null;
  } catch (e) {
    return null;
  }
}

// `.git` is a directory in an ordinary clone, but a FILE holding `gitdir: <path>`
// in a linked worktree — which is how the deploy checkouts are laid out.
function gitDirOf(root) {
  var dot = path.join(root, '.git');
  var stat;
  try { stat = fs.statSync(dot); } catch (e) { return null; }
  if (stat.isDirectory()) return dot;

  var m = (readTrimmed(dot) || '').match(/^gitdir:\s*(.+)$/);
  if (!m) return null;
  return path.isAbsolute(m[1]) ? m[1] : path.resolve(root, m[1]);
}

// In a linked worktree HEAD is per-worktree but refs live in the COMMON dir,
// named by a `commondir` file. Resolving refs against the worktree dir would
// find nothing for any checkout that is on a branch.
function refBaseOf(gitDir) {
  var common = readTrimmed(path.join(gitDir, 'commondir'));
  if (!common) return gitDir;
  return path.isAbsolute(common) ? common : path.resolve(gitDir, common);
}

// Exported for tests: they build fixture directories rather than depending on
// the checkout the suite happens to run in (there is none inside the container).
function gitHeadFrom(root) {
  var dir = gitDirOf(root);
  if (!dir) return null;

  var head = readTrimmed(path.join(dir, 'HEAD'));
  if (!head) return null;

  // Detached HEAD — the deploy worktrees run this way — holds the sha itself.
  if (/^[0-9a-f]{40}$/i.test(head)) return { commit: head, branch: null };

  var m = head.match(/^ref:\s*(.+)$/);
  if (!m) return null;

  var ref    = m[1];
  var branch = ref.replace(/^refs\/heads\//, '');
  var base   = refBaseOf(dir);

  var sha = readTrimmed(path.join(base, ref));
  if (sha && /^[0-9a-f]{40}$/i.test(sha)) return { commit: sha, branch: branch };

  // A packed checkout has no loose ref file.
  var packed = readTrimmed(path.join(base, 'packed-refs'));
  if (packed) {
    var lines = packed.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].trim().split(/\s+/);
      if (parts.length === 2 && parts[1] === ref && /^[0-9a-f]{40}$/i.test(parts[0])) {
        return { commit: parts[0], branch: branch };
      }
    }
  }

  // On a branch whose ref cannot be resolved: the branch name is still true.
  return { commit: null, branch: branch };
}

// The branch must come from whichever source gave us the commit. Falling
// through to the build file when the checkout has no branch would pair a fresh
// commit with the branch name of an OLDER, unrelated one — a detached checkout
// (how the deploy worktrees run) reported `spike/109-pyodide-repl` beside a
// correct current commit until this was split out. 'detached' is the honest
// answer, and pure so the rule can be tested without a checkout.
function resolveBranch(envBranch, git, fileBranch) {
  if (envBranch) return envBranch;
  if (git && git.commit) return git.branch || 'detached';
  return fileBranch || UNKNOWN;
}

function packageVersion() {
  try { return require('../../package.json').version || UNKNOWN; }
  catch (e) { return UNKNOWN; }
}

// Identity of the running build. Every field degrades to 'unknown' rather than
// throwing, so a stack built without the build args still serves a valid body.
function publicInfo() {
  // Precedence: env, then the checkout, then the baked file.
  //
  // env first so a running container can still be corrected without a rebuild.
  // The checkout beats the file because where both exist — a compose deploy —
  // the checkout is what is being served and the file is a leftover from the
  // last image build. Where the file is authoritative (Cloud Run: `**/.git` is
  // in .dockerignore, so there is no checkout in the image) there is no
  // competition to lose.
  var git    = gitHeadFrom(path.join(__dirname, '../..'));
  var built  = fromFile('commit');
  var full   = env('COMMIT_ID') || (git && git.commit) || built;

  var info = {
    commit     : full ? full.substring(0, 7) : UNKNOWN,
    commitFull : full || UNKNOWN,
    branch     : resolveBranch(env('GIT_BRANCH'), git, fromFile('branch')),
    builtAt    : env('BUILD_TIME') || fromFile('builtAt') || UNKNOWN,
    deploy     : env('TRINKET_DEPLOY') || 'default',
    version    : packageVersion(),
    nodeEnv    : process.env.NODE_ENV || 'development'
  };

  info.commitSource = env('COMMIT_ID') ? 'env'
                    : (git && git.commit) ? 'checkout'
                    : built ? 'build'
                    : UNKNOWN;

  // When the code being served is not the code the image was built from, say
  // both. Otherwise `builtAt` silently describes a different commit than
  // `commit` does, which is how the stale reading went unnoticed.
  if (built && full && built !== full) {
    info.buildCommit = built.substring(0, 7);
  }

  return info;
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
  adminExtras : adminExtras,
  // Exported for unit tests, which build fixture checkouts rather than reading
  // whichever repo the suite happens to run in — inside the test container
  // there is no usable .git at all.
  gitHeadFrom   : gitHeadFrom,
  resolveBranch : resolveBranch
};
