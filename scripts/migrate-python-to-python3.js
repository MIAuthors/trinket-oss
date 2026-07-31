#!/usr/bin/env node
//
// scripts/migrate-python-to-python3.js
//
// One-off migration: rewrite already-imported trinket.io "python" trinkets to
// the canonical "python3" lang. trinket.io exports its Python type as
// lang:"python", which in trinket-oss is the DISABLED Skulpt engine (no
// python3/pyodide alias), so those trinkets 404 on open. The importer now
// normalizes python -> python3 (lib/controllers/imports.js), but trinkets
// imported BEFORE that fix are still stored as "python". This rescues them.
//
// trinket.io "python" is really Python-3 code, so the rewrite is safe; the
// trinket then serves on Pyodide (embed/python3.html).
//
// Firestore (GCP deploys — run from repo root, do NOT source .env first):
//   GOOGLE_CLOUD_PROJECT=trinket-uindy FIRESTORE_PROJECT_ID=trinket-uindy \
//   NODE_ENV=production NODE_APP_INSTANCE=cloudrun \
//   node scripts/migrate-python-to-python3.js --dry-run
//
// Firestore (local emulator):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=demo-trinket \
//   FIRESTORE_PROJECT_ID=demo-trinket NODE_ENV=development \
//   node scripts/migrate-python-to-python3.js --dry-run
//
// Mongo / self-host (equivalent one-liner, no script needed):
//   docker exec mongodb mongo trinket --eval \
//     'db.snippets.updateMany({lang:"python"},{$set:{lang:"python3"}})'
//
// Flags:
//   --dry-run       list what would change; write nothing
//   --owner=EMAIL   only migrate trinkets owned by this user (default: all)
//
// Always dry-run first, and take a DB backup/export before the real run.

'use strict';

var projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

require('config');

User    = global.User    = require('../lib/models/user');
Trinket = global.Trinket = require('../lib/models/trinket');

var DRY_RUN    = process.argv.includes('--dry-run');
var ownerArg   = process.argv.find(function (a) { return a.indexOf('--owner=') === 0; });
var OWNER_EMAIL = ownerArg ? ownerArg.slice('--owner='.length) : null;

function findOwnerId(email) {
  return new Promise(function (resolve, reject) {
    User.findByLogin(email, function (err, doc) {
      if (err) return reject(err);
      if (!doc) return reject(new Error('No user found for --owner=' + email));
      resolve(doc._id || doc.id);
    });
  });
}

async function main() {
  var filter = { lang: 'python' };
  if (OWNER_EMAIL) {
    filter._owner = await findOwnerId(OWNER_EMAIL);
    console.log('Scoped to owner ' + OWNER_EMAIL + ' (' + filter._owner + ')');
  }

  var trinkets = await Trinket.find(filter).exec();
  console.log('Found ' + trinkets.length + ' trinket(s) with lang:"python"' +
    (DRY_RUN ? ' (dry run — no writes)' : ''));

  var changed = 0;
  for (var i = 0; i < trinkets.length; i++) {
    var t = trinkets[i];
    console.log('  ' + (DRY_RUN ? '[would fix] ' : '[fixing]  ') +
      (t.shortCode || t.id) + '  ' + (t.name || '(unnamed)'));
    if (!DRY_RUN) {
      t.lang = 'python3';
      await t.save();
    }
    changed++;
  }

  console.log((DRY_RUN ? 'Would migrate ' : 'Migrated ') + changed + ' trinket(s).');
}

main()
  .then(function () { process.exit(0); })
  .catch(function (err) { console.error(err && err.stack || err); process.exit(1); });
