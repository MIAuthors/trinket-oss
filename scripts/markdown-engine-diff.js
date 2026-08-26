#!/usr/bin/env node
//
// scripts/markdown-engine-diff.js
//
// Renders every course material through BOTH markdown engines (legacy and
// modern) and reports real rendering differences (after normalizeHtml).
// This is the evidence tool the migration conversation runs on — see
// .superpowers/sdd/2026-08-15-markdown-engine-bridge/ for the spec.
//
// Usage:
//   node scripts/markdown-engine-diff.js report [--course <idOrSlug>] [--json <outfile>] [--sample <N>]
//
// Honors NODE_ENV / NODE_APP_INSTANCE / TRINKET_DEPLOY / NODE_CONFIG exactly
// like the app: db.backend (mongoose or firestore) is config-driven, so this
// runs unmodified against either backend — just set the same env the app
// would use for that deploy. Examples:
//
//   Local Mongo dev DB:
//     node scripts/markdown-engine-diff.js report
//
//   Firestore emulator:
//     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=demo-trinket \
//     FIRESTORE_PROJECT_ID=demo-trinket NODE_ENV=development \
//     node scripts/markdown-engine-diff.js report
//
//   One course only, and dump the full record list:
//     node scripts/markdown-engine-diff.js report --course my-course-slug --json /tmp/diff.json
//
//   Show what actually differs for the first 5 differing materials:
//     node scripts/markdown-engine-diff.js report --sample 5
//
// Exit codes: 0 on a completed report — even when differences were found,
// this is a report, not a gate. 1 only on operational failure (e.g. DB
// unreachable, bad CLI usage).

var fs = require('fs');

require('config'); // load config first, same as the app (honors NODE_ENV/TRINKET_DEPLOY)

// NOTE on require order: lib/controllers/courses.js (and therefore @hapi/hapi)
// must load before ../config/db (which pulls in mongoose-schema-extend) — the
// reverse order breaks @hapi/validate's own schema compilation (a real
// pre-existing conflict between the two packages, unrelated to this script).
var parserFor = require('../lib/controllers/courses.js').parserFor;

require('../config/db'); // opens the Mongoose connection; no-op when db.backend is firestore

// Models are attached as globals for backwards compatibility — several model
// methods (e.g. Lesson.copy -> Material.findById) reference the bare
// identifier, matching how app.js and the other scripts/*.js tools do this.
global.Course   = require('../lib/models/course');
global.Lesson   = require('../lib/models/lesson');
global.Material = require('../lib/models/material');

var normalizeHtml = require('../lib/shared/html-normalize.js').normalizeHtml;
var excerptAround = require('../lib/shared/diff-excerpt.js').excerptAround;
var engineFor     = require('../lib/shared/markdown-engine.js').engineFor;

var USAGE = 'Usage: node scripts/markdown-engine-diff.js report'
          + ' [--course <idOrSlug>] [--json <outfile>] [--sample <N>]';

var ID_RE       = /^[0-9a-fA-F]{24}$/; // Mongo ObjectId shape; Firestore ids don't collide with this
var EXCERPT_WIDTH = 200; // chars of each engine's output kept per differing material
var BATCH_SIZE  = 30; // Firestore native `in` supports at most 30 comparison values per query

// Synthetic course-setting stand-ins so we exercise exactly the construction
// lib/controllers/courses.js#parserFor already uses in production (course
// export), instead of re-wiring marked/DOMPurify/jsdom/highlight.js here.
// parserFor builds the modern parser lazily (first modern call), so resolving
// both renderers once here also does that construction once, up front, rather
// than inside the first material comparison.
var LEGACY_SETTING = {};
var MODERN_SETTING = { globalSettings : { markdownEngine : 'modern' } };
var legacyRender = parserFor(LEGACY_SETTING);
var modernRender = parserFor(MODERN_SETTING);

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
  return out;
}

// Batched find-by-ids, chunked to stay under Firestore's `in` operator limit.
function findAllByIds(Model, ids) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) { return Promise.resolve([]); }
  return Promise.all(chunk(ids, BATCH_SIZE).map(function(group) {
    return Model.findByIds(group);
  })).then(function(groups) {
    return Array.prototype.concat.apply([], groups).filter(Boolean);
  });
}

// A value is missing if it's absent (flag was last on the command line) or
// looks like another flag (e.g. `--course --json out.json` typo) — either
// way, silently scanning all courses instead of failing loudly would be
// worse than a clear usage error.
function requireValue(argv, i, flagName) {
  var val = argv[i + 1];
  if (val === undefined || val.lastIndexOf('--', 0) === 0) {
    throw new Error(flagName + ' requires a value');
  }
  return val;
}

function parseArgs(argv) {
  var opts = { course: null, json: null, sample: 0 };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--course') { opts.course = requireValue(argv, i, '--course'); i++; }
    else if (argv[i] === '--json') { opts.json = requireValue(argv, i, '--json'); i++; }
    else if (argv[i] === '--sample') {
      var raw = requireValue(argv, i, '--sample');
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
        throw new Error('--sample requires a positive integer (got: ' + raw + ')');
      }
      opts.sample = Number(raw);
      i++;
    }
    else { throw new Error('unrecognized argument: ' + argv[i]); }
  }
  return opts;
}

function findCourses(courseArg) {
  if (!courseArg) {
    return Course.find({ archived : { $ne : true } });
  }
  if (ID_RE.test(courseArg)) {
    return Course.findById(courseArg).then(function(course) {
      return course ? [course] : [];
    });
  }
  return Course.find({ slug : courseArg });
}

function diffMaterial(course, lesson, material, summary, records) {
  var content = material.content || '';

  summary.total++;

  if (!content.trim()) {
    summary.skippedEmpty++;
    return;
  }

  summary.compared++;

  // A render crash is a FINDING, not a fatal: the first real-corpus run died
  // on a pre-existing legacy-engine ReferenceError (`python_types` undefined
  // in the server wrapper — any self-hosted trinket link triggers it), taking
  // the whole report with it. Record which engine crashed and keep sweeping.
  var legacyHtml, modernHtml, crashed = null;
  try { legacyHtml = normalizeHtml(legacyRender(content)); }
  catch (e) { crashed = 'legacy'; legacyHtml = 'RENDER CRASH: ' + e.message; }
  try { modernHtml = normalizeHtml(modernRender(content)); }
  catch (e) { crashed = crashed ? 'both' : 'modern'; modernHtml = 'RENDER CRASH: ' + e.message; }
  if (crashed) {
    summary.crashed = (summary.crashed || 0) + 1;
    summary['crashed_' + crashed] = (summary['crashed_' + crashed] || 0) + 1;
  }

  if (legacyHtml === modernHtml) {
    summary.identical++;
    return;
  }

  summary.differing++;

  // Slugs alone say WHICH materials differ but nothing about HOW, which is the
  // question the migration decision actually turns on. Carry a bounded excerpt
  // of each side around the first divergence in every record (and print it for
  // the first --sample N of them).
  var ex = excerptAround(legacyHtml, modernHtml, EXCERPT_WIDTH);

  records.push({
    courseSlug    : course.slug,
    courseName    : course.name,
    ownerSlug     : course.ownerSlug,
    lessonSlug    : lesson.slug,
    materialSlug  : material.slug,
    engineSetting : engineFor(course),
    divergesAt    : ex.index,
    excerpt       : { legacy : ex.legacy, modern : ex.modern }
  });
}

function diffCourse(course, summary, records) {
  return findAllByIds(Lesson, course.lessons).then(function(lessons) {
    return Promise.all(lessons.map(function(lesson) {
      return findAllByIds(Material, lesson.materials).then(function(materials) {
        materials.forEach(function(material) {
          diffMaterial(course, lesson, material, summary, records);
        });
      });
    }));
  });
}

function printSummary(summary, records, sample) {
  console.log('markdown-engine-diff report');
  console.log('  total materials       : ' + summary.total);
  console.log('  compared (non-empty)  : ' + summary.compared);
  console.log('  identical              : ' + summary.identical);
  console.log('  differing              : ' + summary.differing);
  console.log('  skipped (empty content): ' + summary.skippedEmpty);
  if (summary.crashed) {
    console.log('  RENDER CRASHES         : ' + summary.crashed +
      ' (legacy: ' + (summary.crashed_legacy || 0) +
      ', modern: ' + (summary.crashed_modern || 0) +
      ', both: ' + (summary.crashed_both || 0) + ')');
  }

  if (!records.length) { return; }

  var byCourse = {};
  records.forEach(function(r) {
    var key = r.ownerSlug + '/' + r.courseSlug;
    if (!byCourse[key]) {
      byCourse[key] = { courseName : r.courseName, ownerSlug : r.ownerSlug, courseSlug : r.courseSlug, count : 0 };
    }
    byCourse[key].count++;
  });

  console.log('\n  differing materials by course:');
  Object.keys(byCourse).sort().forEach(function(key) {
    var c = byCourse[key];
    console.log('    ' + c.ownerSlug + '/' + c.courseSlug + ' ("' + c.courseName + '"): ' + c.count);
  });

  if (!sample) { return; }

  var shown = records.slice(0, sample);
  console.log('\n  first ' + shown.length + ' difference(s), excerpted around the first divergence:');
  shown.forEach(function(r) {
    console.log('\n    ' + r.ownerSlug + '/' + r.courseSlug + '/' + r.lessonSlug + '/' + r.materialSlug
              + '  (engine: ' + r.engineSetting + ', diverges at char ' + r.divergesAt + ')');
    console.log('      legacy: ' + JSON.stringify(r.excerpt.legacy));
    console.log('      modern: ' + JSON.stringify(r.excerpt.modern));
  });
}

function run() {
  var subcommand = process.argv[2];
  if (subcommand !== 'report') {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  var opts;
  try {
    opts = parseArgs(process.argv.slice(3));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  var summary = { total : 0, compared : 0, identical : 0, differing : 0, skippedEmpty : 0 };
  var records = [];

  return findCourses(opts.course).then(function(courses) {
    return Promise.all(courses.map(function(course) {
      return diffCourse(course, summary, records);
    }));
  }).then(function() {
    printSummary(summary, records, opts.sample);

    if (opts.json) {
      fs.writeFileSync(opts.json, JSON.stringify({ summary : summary, differences : records }, null, 2));
      console.log('\nFull record list written to ' + opts.json);
    }

    process.exit(0);
  }).catch(function(err) {
    console.error('markdown-engine-diff failed:', err && err.stack || err);
    process.exit(1);
  });
}

run();
