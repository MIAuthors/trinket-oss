const { test, expect } = require('@playwright/test');

// Issue #108 (partial): a Stop control for the cases where stopping is possible
// at all.
//
// Measured first, because the answer is not obvious — Pyodide runs on the main
// thread, so whether a button can even be CLICKED depends on the program:
//
//   while True: pass                       -> tab FROZEN   (click never delivered)
//   while True: print('.')                 -> tab FROZEN
//   while True: print('.'); time.sleep(1)  -> tab RESPONSIVE
//
// sleep() yields to the event loop; print() and a bare loop do not. So Stop is
// implemented as cooperative cancellation at yield points — rate() for VPython,
// time.sleep() for everything else — which covers exactly the programs where a
// click can land, and preserves the student's editor content (no reload).
//
// The frozen cases are NOT covered and cannot be by any button; that needs
// Pyodide in a Worker, which is why #108 stays open.
test.describe('Stop control (#108, partial)', () => {
  async function runCode(page, code) {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, code);
    await page.locator('.run-it').first().click();
  }

  async function output(page) {
    return page.evaluate(() => document.querySelector('#outputContainer')?.innerText || '');
  }

  test('is hidden until a program runs', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await expect(page.locator('.stop-it')).toBeHidden();
  });

  test('appears while a program is running', async ({ page }) => {
    await runCode(page, "import time\n\nwhile True:\n    print('.')\n    time.sleep(1)");
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 90_000 });
  });

  test('stops a sleeping loop, and the page stays usable', async ({ page }) => {
    await runCode(page, "import time\n\nwhile True:\n    print('tick')\n    time.sleep(1)");
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 90_000 });

    await page.locator('.stop-it').click();

    // The loop unwinds at its next sleep and the run ends — Stop goes away again.
    await expect(page.locator('.stop-it')).toBeHidden({ timeout: 30_000 });

    const text = await output(page);
    expect(text).toContain('tick');        // it really was running
    expect(text).toContain('stopping');    // and we acknowledged the click
  });

  test('does not restart the program (Stop means stop)', async ({ page }) => {
    // Clicking Run mid-run restarts a VPython animation by design; Stop must NOT
    // inherit that behaviour.
    await runCode(page, "import time\n\nwhile True:\n    print('tick')\n    time.sleep(1)");
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 90_000 });
    await page.locator('.stop-it').click();
    await expect(page.locator('.stop-it')).toBeHidden({ timeout: 30_000 });

    const before = (await output(page)).length;
    await page.waitForTimeout(3000);
    const after = (await output(page)).length;
    expect(after, 'output should stop growing once stopped').toBe(before);
  });

  test('REGRESSION: a normal program still runs to completion', async ({ page }) => {
    await runCode(page, 'print("finished normally")');

    await expect(async () => {
      expect(await output(page)).toContain('finished normally');
    }).toPass({ timeout: 90_000 });

    await expect(page.locator('.stop-it')).toBeHidden();
  });
});
