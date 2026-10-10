const { test, expect } = require('@playwright/test');

// The Web VPython (glowscript) Stop button, end to end against the real
// runtime. Needs the local stack built from this branch: the Dockerfile vendors
// the 3.2.3 runtime and builds the CSS (test/browser/README.md covers the
// stack). Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const LOOP = 'Web VPython 3.2\nb = box()\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    b.rotate(angle=0.05, axis=vec(0, 1, 0))\n    print(n)\n';
const FINITE = 'Web VPython 3.2\nsphere()\nfor i in range(3):\n    rate(10)\n';
const BROKEN = 'Web VPython 3.2\nwhile True\n    rate(30)\n';
// A button whose handler raises, beside a main loop that keeps going.
const HANDLER_ERROR = 'Web VPython 3.2\nb = box()\ndef boom(evt):\n    raise ValueError("boom")\nbutton(bind=boom, text="Boom")\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    print(n)\n';

// A Stop within 500 ms of a Run is ignored as the second click of a double-click
// on Run (STOP_GRACE_MS in glowscript-run-state.js), so these tests wait past it.
const PAST_DOUBLE_CLICK_GUARD_MS = 600;

async function run(page, code) {
  await page.goto('/embed/glowscript');
  await expect(page.locator('.ace_editor')).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}

const runControl = (page) => page.locator('.run-it').first();
// Fails fast if the runner or its print area is missing, instead of at the test timeout.
const printed = (page) => page.frameLocator('#glowscriptOutput').locator('textarea#print').inputValue({ timeout: 5_000 });
// For expect.poll. The print area appears only at the program's first print(),
// after the runtime loads, and a generator that rejects ends the poll on its
// first call (Playwright 1.48) instead of being retried. So a read that fails
// counts as no output yet, and the poll's own timeout decides.
const printedLines = async (page) => (await printed(page).catch(() => '')).split('\n').filter(Boolean).length;

test.describe('Web VPython Stop button', () => {
  test('Run turns into Stop, with the strip, while a program runs', async ({ page }) => {
    await run(page, LOOP);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page).locator('label')).toHaveText('Stop');
    await expect(runControl(page).locator('svg.run-stop-trace')).toBeVisible();
  });

  test('Stop freezes the program in place and returns to Run', async ({ page }) => {
    await run(page, LOOP);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');
    await expect(runControl(page).locator('svg.run-stop-trace')).toBeHidden();

    // Parked, not torn down: the runner is still there and no stopped note shows.
    await expect(page.locator('#glowscriptOutput')).toHaveCount(1);
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);

    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
  });

  // Save asks the runner for a thumbnail. The runtime's screenshot goes through
  // the waits that keep a stopped program parked, so the runner lets new waits
  // through while the screenshot is taken.
  test('a stopped program still answers a snapshot request', async ({ page }) => {
    await run(page, LOOP);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');
    // Parked, not torn down: the runner that has to answer is still there.
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);

    const snapshot = await page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no snapshot within 5 s')), 5_000);
      window.addEventListener('message', function onMessage(e) {
        let data;
        try { data = JSON.parse(e.data); } catch (err) { return; }
        if (data && data.snapshot) {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(data.snapshot);
        }
      });
      document.getElementById('glowscriptOutput').contentWindow.postMessage('glowscript.snapshot', '*');
    }));
    expect(snapshot).toMatch(/^data:image\/png/);
  });

  // An error raised outside the program's main flow leaves that flow running,
  // so the control must stay Stop. Whether 3.2.3 reports a handler's error to
  // the page at all is unconfirmed; this pins the outcome either way, and does
  // not look at the error banner.
  test('an error in an event handler does not end a running program', async ({ page }) => {
    await run(page, HANDLER_ERROR);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await page.frameLocator('#glowscriptOutput').getByRole('button', { name: 'Boom' }).click();
    // Half a second of the loop going on: time for any error report to arrive.
    const afterClick = await printedLines(page);
    await expect.poll(() => printedLines(page)).toBeGreaterThan(afterClick + 15);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page).locator('label')).toHaveText('Stop');

    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);
    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
  });

  test('a program that finishes returns to Run on its own', async ({ page }) => {
    await run(page, FINITE);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
    // Finished, not errored or given up loading: no alert banner was raised.
    await expect(page.locator('#statusMessages')).toHaveCount(0);
  });

  test('a compile error returns to Run', async ({ page }) => {
    await run(page, BROKEN);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
    // The program's error banner, not the runtime-load failure one.
    await expect(page.locator('#statusMessages').first()).toBeAttached();
    await expect(page.getByText(/could not be loaded/)).toHaveCount(0);
  });

  // Enter on the output-only toolbar's <button> used to dispatch twice: embed.js
  // acts on the keypress and the browser then synthesizes a click. A Stop before
  // the runner is ready tears the run down at once, so the second dispatch (by
  // then Run again) restarted the program; glowscript.js now cancels that click.
  // The page is kept from ever seeing the runner's ready message, so this test
  // always takes that teardown path instead of racing the runtime's load time.
  test('Enter on the output-only Stop button stops the program instead of restarting it', async ({ page }) => {
    const res = await page.request.post('/api/trinkets', {
      data: { lang: 'glowscript', code: LOOP, name: 'stop-enter-' + Date.now() },
    });
    expect(res.ok(), 'trinket create should succeed').toBeTruthy();
    const body = await res.json();
    const shortCode = (body.data || body).shortCode;

    await page.addInitScript(() => {
      window.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && e.data.includes('glowscript.ready')) { e.stopImmediatePropagation(); }
      }, true);
    });

    await page.goto('/embed/glowscript/' + shortCode + '?outputOnly=true');
    const control = page.locator('button.run-it');
    await expect(control).toBeVisible();

    await control.press('Enter');                                          // Run
    await expect(control).toHaveClass(/run-state-running/);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await expect(control.locator('label')).toHaveText('Stop');
    // runCode() moved focus to #honeypot; press() focuses the control again.
    await control.press('Enter');                                          // Stop
    await expect(page.locator('.glowscript-stopped-note')).toBeVisible();  // the teardown path ran
    await expect(control).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await page.waitForTimeout(1_500);
    await expect(control, 'Stop must not restart the program').not.toHaveClass(/run-state-/);
  });
});
