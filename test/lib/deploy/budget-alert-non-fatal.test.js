// The budget alert is a courtesy step at the very END of a deploy, long after
// the app is live. It must never be able to ABORT the deploy: everything after
// it — most importantly the CDN asset publish — still has to run.
//
// It could. On 2026-09-01 a uindy deploy died here, silently. The billing
// account behind uindy denies `gcloud billing budgets list`, the call was
// wrapped in `2>/dev/null`, and the script runs `set -euo pipefail`: the log
// simply stopped after the section header, several steps before the CDN
// publish. Cloud Run moved to the new commit while Firebase Hosting kept
// serving the previous deploy's JavaScript, so the fixes that deploy existed
// to ship were not actually live in production.
//
// This runs the REAL block out of the shipped script, under a gcloud stub that
// reproduces that permission denial.
'use strict';
const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy-cloudrun.sh');

const START = '--- Ensuring billing budget alert';
const END   = "# --- Publish this deploy's assets to the CDN";

function budgetBlock() {
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
  const from = lines.findIndex(l => l.includes(START));
  const to   = lines.findIndex(l => l.startsWith(END));
  expect(from, `could not find the budget-alert section in ${SCRIPT}`).toBeGreaterThan(-1);
  expect(to, `could not find the CDN-publish section in ${SCRIPT}`).toBeGreaterThan(from);
  return lines.slice(from, to).join('\n');
}

// A gcloud that resolves the billing account but denies listing budgets —
// the shape of a billing account whose IAM denies the budgets API to this caller.
const GCLOUD_STUB = `#!/bin/bash
if [[ "$1" == "billing" && "$2" == "projects" ]]; then
  echo "billingAccounts/0000AA-BBBB11-CCCC22"; exit 0
fi
if [[ "$1" == "billing" && "$2" == "budgets" ]]; then
  echo "ERROR: does not have permission to access billingAccounts instance" >&2
  exit 1
fi
exit 0
`;

// A gcloud that works normally. LIST_OUT is what `budgets list` prints:
// a name means a budget already exists, empty means none does.
function healthyStub(listOut) {
  return `#!/bin/bash
if [[ "$1" == "billing" && "$2" == "projects" ]]; then
  echo "billingAccounts/0000AA-BBBB11-DDDD33"; exit 0
fi
if [[ "$1" == "billing" && "$2" == "budgets" && "$3" == "list" ]]; then
  ${listOut ? `echo "${listOut}"` : ':'}; exit 0
fi
if [[ "$1" == "billing" && "$2" == "budgets" && "$3" == "create" ]]; then
  echo "CREATE_CALLED"; exit 0
fi
exit 0
`;
}

function runBlock(stub) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  fs.writeFileSync(path.join(dir, 'gcloud'), stub, { mode: 0o755 });
  const harness = [
    'set -euo pipefail',
    'MONTHLY_BUDGET=10',
    'GOOGLE_CLOUD_PROJECT=trinket-uindy',
    budgetBlock(),
    'echo "REACHED_CDN_PUBLISH"',
  ].join('\n');
  const file = path.join(dir, 'block.sh');
  fs.writeFileSync(file, harness);
  return spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

function runBlockWithDeniedBudgets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  fs.writeFileSync(path.join(dir, 'gcloud'), GCLOUD_STUB, { mode: 0o755 });

  // `set -euo pipefail` is what the real script runs under; without it this
  // test cannot reproduce the abort.
  const harness = [
    'set -euo pipefail',
    'MONTHLY_BUDGET=10',
    'GOOGLE_CLOUD_PROJECT=trinket-uindy',
    budgetBlock(),
    'echo "REACHED_CDN_PUBLISH"',
  ].join('\n');

  const file = path.join(dir, 'block.sh');
  fs.writeFileSync(file, harness);
  return spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

describe('the budget-alert step cannot abort a deploy', () => {
  it('still reaches the CDN publish when the billing account denies budgets list', () => {
    const r = runBlockWithDeniedBudgets();
    expect(r.stdout, 'the deploy must continue past the budget alert to the CDN publish')
      .toContain('REACHED_CDN_PUBLISH');
    expect(r.status, 'a courtesy step must not fail the deploy').toBe(0);
  });

  it('says why it skipped instead of failing silently', () => {
    const r = runBlockWithDeniedBudgets();
    // Not merely the section header — an actual statement that it was skipped.
    expect(r.stdout, 'a silent skip is what made this cost a production incident')
      .toMatch(/skipping budget alert/i);
  });

  // The refactor that made failure non-fatal must not have broken the two
  // paths that were already working.
  it('skips creating one when a budget already exists', () => {
    const r = runBlock(healthyStub('billingAccounts/X/budgets/abc'));
    expect(r.stdout).toContain('Budget alert already exists');
    expect(r.stdout).not.toContain('CREATE_CALLED');
    expect(r.stdout).toContain('REACHED_CDN_PUBLISH');
    expect(r.status).toBe(0);
  });

  it('creates one when none exists', () => {
    const r = runBlock(healthyStub(''));
    expect(r.stdout).toContain('CREATE_CALLED');
    expect(r.stdout).toContain('Budget alert created');
    expect(r.stdout).toContain('REACHED_CDN_PUBLISH');
    expect(r.status).toBe(0);
  });
});
