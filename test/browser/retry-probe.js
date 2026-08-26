// #188: force a runtime-file load failure after pressing Run, see if it recovers.
const { chromium } = require('@playwright/test');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  let attempts = 0;
  await ctx.route(/glow\.3\.2\.3\.min\.js/, (route) => {
    attempts++;
    if (attempts === 1) { console.log('  attempt 1 -> ABORTED (simulated shed)'); return route.abort('failed'); }
    console.log(`  attempt ${attempts} -> allowed through`);
    return route.continue();
  });
  await page.goto(process.env.PROBE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.click('a.run-it');
  console.log('  clicked Run');
  await page.waitForTimeout(16000);          // covers 1s / 3s / 7s backoff
  console.log(`RESULT: glow.js requested ${attempts} time(s)`);
  console.log(attempts >= 2 ? 'PASS - the page retried after the failure'
                            : 'FAIL - no retry observed');
  await b.close();
})();
