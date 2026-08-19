#!/usr/bin/env node
//
// scripts/legacy-shortcode-map.js
//
// Read-only. Maps trinket.io shortCodes to the ones they were given when
// imported here, so links baked into external material (D2L assignments,
// syllabi, handouts) can be repointed off trinket.io.
//
// Imports do not preserve ids, but each imported trinket keeps the original in
// its indexed `legacyShortCode` field — that field is the mapping.
//
// Usage against production (run from repo root, do NOT source .env first):
//   GOOGLE_CLOUD_PROJECT=<project> \
//   FIRESTORE_PROJECT_ID=<project> \
//   NODE_ENV=production \
//   NODE_APP_INSTANCE=cloudrun \
//   node scripts/legacy-shortcode-map.js abee451f3e 6fde40b288 ...
//
// Usage against the local emulator:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   GOOGLE_CLOUD_PROJECT=demo-trinket FIRESTORE_PROJECT_ID=demo-trinket \
//   NODE_ENV=development \
//   node scripts/legacy-shortcode-map.js abee451f3e
//
// Options:
//   --owner <userId>   restrict to one owner's trinkets (skips others' copies)
//   --lang <lang>      language segment for the printed URL (default glowscript)
//   --csv              emit "legacy,new,url,title" instead of a table
//
// This script only reads. It never writes.
//

'use strict';

var projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

var config = require('config');

User    = global.User    = require('../lib/models/user');
Trinket = global.Trinket = require('../lib/models/trinket');

var args = process.argv.slice(2);

function optValue(flag) {
  var i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

var OWNER = optValue('--owner');
var LANG  = optValue('--lang') || 'glowscript';
var CSV   = args.includes('--csv');

// Everything that isn't a flag or a flag's value is a legacy shortCode.
var SKIP = ['--owner', '--lang'];
var codes = args.filter(function(a, i) {
  if (a.charAt(0) === '-') return false;
  var prev = args[i - 1];
  if (prev && SKIP.indexOf(prev) >= 0) return false;
  return true;
});

if (!codes.length) {
  console.error('Usage: node scripts/legacy-shortcode-map.js [--owner ID] [--lang L] [--csv] <legacyShortCode> ...');
  process.exit(1);
}

var baseUrl = (config.has('url') ? config.get('url') : '') || '';

var lookup = OWNER
  ? Trinket.findByOwnerAndLegacyShortCodes(OWNER, codes)
  : Trinket.findByLegacyShortCodes(codes);

Promise.resolve(lookup)
  .then(function(trinkets) {
    trinkets = trinkets || [];

    var byLegacy = {};
    trinkets.forEach(function(t) {
      // Keep the first hit; a legacy code can map to several copies if the
      // same export was imported by more than one account.
      if (!byLegacy[t.legacyShortCode]) byLegacy[t.legacyShortCode] = [];
      byLegacy[t.legacyShortCode].push(t);
    });

    var rows = codes.map(function(code) {
      var hits = byLegacy[code] || [];
      var t = hits[0];
      return {
        legacy: code,
        found: !!t,
        shortCode: t ? t.shortCode : '',
        title: t ? (t.title || '') : '',
        url: t ? baseUrl + '/' + LANG + '/' + t.shortCode : '',
        duplicates: hits.length > 1 ? hits.length : 0
      };
    });

    if (CSV) {
      console.log('legacy,new,url,title');
      rows.forEach(function(r) {
        console.log([r.legacy, r.shortCode, r.url, '"' + String(r.title).replace(/"/g, '""') + '"'].join(','));
      });
    } else {
      rows.forEach(function(r) {
        if (r.found) {
          console.log(r.legacy + '  ->  ' + r.shortCode + '   ' + r.url);
          if (r.title) console.log('              ' + r.title);
          if (r.duplicates) console.log('              NOTE: ' + r.duplicates + ' trinkets share this legacy code (showing the first; use --owner to disambiguate)');
        } else {
          console.log(r.legacy + '  ->  NOT FOUND');
        }
      });
    }

    var missing = rows.filter(function(r) { return !r.found; }).length;
    console.error('\n' + (rows.length - missing) + '/' + rows.length + ' resolved' +
                  (missing ? ('; ' + missing + ' not found — check the owner, or the trinket may not have been imported') : ''));
    process.exit(0);
  })
  .catch(function(err) {
    console.error('Lookup failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
