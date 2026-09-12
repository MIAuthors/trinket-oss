const { test, expect } = require('@playwright/test');

// The plot-style panel (#251) against a real deploy. The unit harness drives the
// adapter in jsdom; this is the first thing to run the vendored bundle in a real
// browser, against real matplotlib output from real Pyodide.
async function run(page, code) {
  await page.goto('/embed/python3');
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}
const pill = (page) => page.locator('plotpolish-panel');

test.describe('#251 plot style panel', () => {
  test('mounts over a matplotlib figure', async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');

    await run(page, 'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[2,1,3])\nplt.show()\n');
    await pill(page).waitFor({ state: 'attached', timeout: 90000 });
    console.log('  [#251] panel mounted over a matplotlib figure');
    expect(await pill(page).count()).toBe(1);
  });

  // The VPython-scene guard is NOT reachable on a main-thread glowscript embed:
  // /embed/glowscript has no #graphic element at all (verified on the trial —
  // getElementById('graphic') is null) and renders its scene inside a separate
  // sandboxed frame, so hasFigure() returns false before any container check.
  //
  // The guard's real trigger is the WORKER path, where #vpython-scene is built
  // inside #graphic on a pyodide embed — which needs features.workerVPython, off
  // by default. Both container ids are covered by the jsdom harness in
  // test/unit/plotpolish-adapter.test.js; this is the deployed counterpart, and
  // it skips loudly rather than passing vacuously where it cannot fire.
  test('does NOT mount over a worker VPython scene', async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');
    test.skip(!/workerVPython\s*:\s*true/.test(html),
      'features.workerVPython is off — the #vpython-scene container is never built, '
      + 'so this guard cannot be exercised here (unit harness covers both ids)');

    await run(page, 'from vpython import sphere, color\nsphere(color=color.red)\n');
    await page.locator('#vpython-scene').waitFor({ state: 'attached', timeout: 90000 });
    await page.waitForTimeout(2500);
    console.log('  [#251] panels over a worker VPython scene: ' + await pill(page).count());
    expect(await pill(page).count(), 'no style pill over a 3D scene').toBe(0);
  });

  test('leaves a print-only program alone', async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');

    await run(page, 'print("no figure here")\n');
    await page.waitForTimeout(4000);
    expect(await pill(page).count(), 'no figure means no pill').toBe(0);
  });
});
