'use strict';

// Startup smoke test — runs before the HTTP server begins accepting traffic.
// Prints a clear summary of which backends are configured and whether they
// are reachable.  Any critical failure is returned so the caller can exit.

const config  = require('config');
const TIMEOUT = 5000; // ms to wait for each connectivity probe

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

async function probeFirestore(projectId) {
  const Firestore = require('@google-cloud/firestore');
  const opts = { ignoreUndefinedProperties: true };
  if (projectId) opts.projectId = projectId;
  const db = new Firestore(opts);
  await db.collection('_health').doc('startup').get();
}

async function probeMongo(host, port, database) {
  const mongoose = require('mongoose');
  const uri = `mongodb://${host}:${port}/${database}`;
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: TIMEOUT });
  await conn.asPromise();
  await conn.close();
}

// Supported deployment shapes are ALL-OR-NONE (design decision 3, see
// docs/GCR-PICUP-TRIAL-MERGE-NOTES.md): choosing GCP means firestore AND
// Firebase Auth together; self-host means mongoose AND local auth. The
// crossed combinations are unsupported — firestore+local in particular is
// the shape where backend-semantics bugs (isModified/save-hook misses)
// corrupt data silently. Unsupported shapes refuse to start in production
// unless app.allowUnsupportedConfig is set; everywhere else they warn.
// Pure function (cfg + env in, verdict out) so tests can cover the matrix
// without booting or mutating the real config.
function checkShape(cfg, env) {
  const db   = (cfg.db   && cfg.db.backend)    || 'mongoose';
  const auth = (cfg.auth && cfg.auth.provider) || 'local';
  const allow = !!(cfg.app && cfg.app.allowUnsupportedConfig);

  const supported =
    (db === 'firestore') === (auth === 'firebase'); // both GCP or neither

  if (supported) {
    return { level: 'ok', lines: [] };
  }

  const level = (env === 'production' && !allow) ? 'fatal' : 'warn';
  const lines = [
    `  UNSUPPORTED CONFIG SHAPE: db.backend=${db} + auth.provider=${auth}`,
    `  Supported shapes are all-or-none:`,
    `    self-host:  db.backend: mongoose   + auth.provider: local`,
    `    GCP:        db.backend: firestore  + auth.provider: firebase`,
    level === 'fatal'
      ? `  Refusing to start in production. To proceed anyway (unsupported,`
      : `  Continuing (non-production). In production this refuses to start`,
    level === 'fatal'
      ? `  at your own risk), set app.allowUnsupportedConfig: true.`
      : `  unless app.allowUnsupportedConfig: true is set.`
  ];
  return { level: level, lines: lines };
}

// Are the installed dependencies the ones package.json asks for?
//
// Several deploys keep node_modules in a Docker *volume* while bind-mounting
// the source (see docker-compose.yml). Rebuilding the image does not refresh
// that volume, so a commit which adds a dependency starts an app whose modules
// are one release behind — and the only symptom is `Cannot find module 'x'`
// from deep inside a require chain, in a restart loop, with a build log that
// looks perfectly clean.
//
// This reports the missing names and the command that fixes them. It does not
// install anything: an app that reaches out to a package registry as it boots
// is an app that cannot start when the registry is unreachable.
function checkDependencies(rootDir) {
  const path = require('path');
  const fs   = require('fs');
  const root = rootDir || path.join(__dirname, '..', '..');

  let declared;
  try {
    declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies || {};
  } catch (err) {
    return { missing: [], error: err.message };
  }

  const missing = Object.keys(declared).filter(function(name) {
    return !fs.existsSync(path.join(root, 'node_modules', name));
  });

  return { missing: missing, error: null };
}

async function run() {
  const dbBackend = (config.db && config.db.backend) || 'mongoose';
  const sessionBackend =
    (config.app.plugins.session.cache && config.app.plugins.session.cache.backend) ||
    dbBackend;

  const checks = [];
  let fatal = false;

  // ── Supported-shape gate (all-or-none) ────────────────────────────────────
  const shape = checkShape(config, process.env.NODE_ENV);
  if (shape.level !== 'ok') {
    shape.lines.forEach(l => checks.push(l));
    if (shape.level === 'fatal') fatal = true;
  }

  // ── DB backend ────────────────────────────────────────────────────────────
  if (dbBackend === 'firestore') {
    const emulator = process.env.FIRESTORE_EMULATOR_HOST || '(production)';
    const projectId = config.db.firestore && config.db.firestore.projectId;
    try {
      await withTimeout(probeFirestore(projectId), TIMEOUT, 'Firestore');
      checks.push(`  DB:      firestore  project=${projectId}  emulator=${emulator}  ✓`);
    } catch (err) {
      checks.push(`  DB:      firestore  project=${projectId}  emulator=${emulator}  ✗  ${err.message}`);
      fatal = true;
    }
  } else {
    const host = config.db.mongo && config.db.mongo.host;
    const port = config.db.mongo && config.db.mongo.port;
    const db   = config.db.mongo && config.db.mongo.database;
    try {
      await withTimeout(probeMongo(host, port, db), TIMEOUT, 'MongoDB');
      checks.push(`  DB:      mongoose   ${host}:${port}/${db}  ✓`);
    } catch (err) {
      checks.push(`  DB:      mongoose   ${host}:${port}/${db}  ✗  ${err.message}`);
      fatal = true;
    }
  }

  // ── Session cache ─────────────────────────────────────────────────────────
  if (sessionBackend === 'memory') {
    checks.push(`  Session: memory     (in-process, not persistent)  ✓`);
  } else if (sessionBackend === 'firestore') {
    // Already probed above if db backend is also firestore; skip a second round-trip.
    if (dbBackend !== 'firestore') {
      const projectId = config.db.firestore && config.db.firestore.projectId;
      try {
        await withTimeout(probeFirestore(projectId), TIMEOUT, 'Firestore (session)');
        checks.push(`  Session: firestore  ✓`);
      } catch (err) {
        checks.push(`  Session: firestore  ✗  ${err.message}`);
        fatal = true;
      }
    } else {
      checks.push(`  Session: firestore  (same connection as DB)  ✓`);
    }
  } else {
    checks.push(`  Session: mongoose   (same connection as DB)`);
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  const width = 60;
  // ── Dependencies ──────────────────────────────────────────────────────────
  const deps = checkDependencies();
  if (deps.missing.length) {
    const shown = deps.missing.slice(0, 6).join(', ') +
      (deps.missing.length > 6 ? `, +${deps.missing.length - 6} more` : '');
    checks.push(`  Deps:    ${deps.missing.length} declared package(s) not installed  ✗  ${shown}`);
    checks.push(`           node_modules is stale — in Docker it is a volume that a`);
    checks.push(`           rebuild does not refresh. Fix with:`);
    checks.push(`             docker compose exec -T app npm ci --no-audit --no-fund`);
    checks.push(`           then restart. (Outside Docker: npm ci)`);
    fatal = true;
  }

  console.log('\n' + '─'.repeat(width));
  console.log('  STARTUP CHECK');
  console.log('─'.repeat(width));
  checks.forEach(l => console.log(l));
  console.log('─'.repeat(width) + '\n');

  return !fatal;
}

module.exports = { run, checkShape, checkDependencies };
