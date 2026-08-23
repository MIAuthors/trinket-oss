#!/usr/bin/env node
// Remove orphaned deploy-test fixtures.
//
// In-test cleanup fails sometimes — a run crashes, times out, or is killed — so
// tests must never depend on it having worked. This sweeps what they left
// behind, and is safe to run on a schedule.
//
// SAFETY, by construction rather than by care:
//   * only deletes courses whose name matches test/browser/fixtures.js's PREFIX
//   * only deletes those older than --older-than hours (default 6), so a run in
//     flight is never pulled out from under itself
//   * dry-run by default; deleting requires --yes
//   * never enumerates or touches anything outside the authenticated account's
//     own courses
//
//   node scripts/smoke-cleanup.js --base-url https://trial-merge.spvi.net \
//     --state test/browser/.auth/trial-merge.spvi.net.json [--older-than 6] [--yes]
const fs = require('fs');
const path = require('path');
const fixtures = require('../test/browser/fixtures');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const baseUrl   = arg('base-url');
const statePath = arg('state');
const olderThan = parseFloat(arg('older-than', '6'));
const commit    = process.argv.includes('--yes');

if (!baseUrl || !statePath) {
  console.error('usage: smoke-cleanup.js --base-url <url> --state <storageState.json> [--older-than 6] [--yes]');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(path.resolve(statePath), 'utf8'));
const cookie = state.cookies
  .filter((c) => /session/i.test(c.name))
  .map((c) => c.name + '=' + c.value)
  .join('; ');
if (!cookie) { console.error('no session cookie in ' + statePath); process.exit(1); }

async function api(method, p) {
  const res = await fetch(new URL(p, baseUrl).toString(), { method, headers: { Cookie: cookie } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  const listed = await api('GET', '/api/courses');
  if (listed.status !== 200) {
    console.error('could not list courses (HTTP ' + listed.status + ') — is the session still valid?');
    process.exit(1);
  }
  const courses = listed.body.data || listed.body.courses || [];
  const cutoff = Date.now() - olderThan * 3600 * 1000;

  const stale = courses.filter((c) => {
    if (!fixtures.isFixtureName(c.name)) return false;
    const created = Date.parse(c.created || '');
    return isFinite(created) && created < cutoff;
  });

  console.log('  courses visible: ' + courses.length +
              ' | fixtures: ' + courses.filter((c) => fixtures.isFixtureName(c.name)).length +
              ' | older than ' + olderThan + 'h: ' + stale.length);

  for (const c of stale) {
    if (!commit) { console.log('  would delete: ' + c.id + '  ' + c.name + '  (' + c.created + ')'); continue; }
    const del = await api('DELETE', '/api/courses/' + c.id);
    console.log('  deleted ' + (del.status === 200 ? 'ok  ' : 'FAILED(' + del.status + ') ') + c.id + '  ' + c.name);
  }
  if (!commit && stale.length) console.log('\n  dry run — pass --yes to delete');
})();
