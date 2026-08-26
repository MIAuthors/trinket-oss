#!/usr/bin/env node
// Capture a signed-in session from a real deployment, once, by hand — so tests
// that need authentication can run unattended afterwards.
//
// WHY THIS WORKS EVEN FOR GOOGLE-ONLY DEPLOYS. The Firebase JS SDK keeps its
// own auth state in IndexedDB, which Playwright's storageState does NOT capture.
// That does not matter: what the server actually trusts is trinket's own
// `__session` cookie, set by POST /api/auth/session once sign-in completes.
// Sessions are stored server-side (maxCookieSize: 0), so the cookie is only a
// key and stays valid across deploys. A cookie IS captured by storageState.
//
//   node save-session.js https://rba-merge-trial.spvi.net
//
// A headed Chrome opens. Sign in however that deploy requires — Google included.
// When you land signed-in, come back here and press Enter.
//
// ⚠️ The saved file is a live credential: anyone holding it is that user until
// the session expires. It is written to .auth/, which is gitignored. Do not
// capture a production instructor session unless you accept that the file grants
// access to real student work.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('usage: node save-session.js <https://deploy-host>');
  process.exit(1);
}

(async () => {
  const host = new URL(target).host;
  const outDir = path.join(__dirname, '.auth');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, host + '.json');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL('/login', target).toString());

  console.log('\n  Sign in in the browser window, then press Enter here.');
  await new Promise((resolve) => process.stdin.once('data', resolve));

  const state = await context.storageState();
  const cookies = state.cookies.filter((c) => /session/i.test(c.name));
  if (!cookies.length) {
    console.error('\n  No session cookie found — sign-in did not complete. Nothing written.');
    await browser.close();
    process.exit(1);
  }

  fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
  console.log('  Saved ' + cookies.map((c) => c.name).join(', ') + ' -> ' + path.relative(process.cwd(), outFile));
  console.log('  Use it:  SMOKE_STORAGE_STATE=' + outFile + ' npx playwright test -c playwright.deploy.config.js\n');
  await browser.close();
  process.exit(0);
})();
