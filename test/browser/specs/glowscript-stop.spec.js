const { test, expect } = require('@playwright/test');

// The Web VPython (glowscript) Stop button, end to end against the real
// runtime. Needs the local stack with the vendored 3.2.3 runtime
// (test/browser/README.md). Spec:
// docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const LOOP = 'Web VPython 3.2\nb = box()\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    b.rotate(angle=0.05, axis=vec(0, 1, 0))\n    print(n)\n';
const FINITE = 'Web VPython 3.2\nsphere()\nfor i in range(3):\n    rate(10)\n';
const BROKEN = 'Web VPython 3.2\nwhile True\n    rate(30)\n';

async function run(page, code) {
  await page.goto('/embed/glowscript');
  await expect(page.locator('.ace_editor')).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}

const runControl = (page) => page.locator('.run-it').first();
const printed = (page) => page.frameLocator('#glowscriptOutput').locator('textarea#print').inputValue();
const printedLines = async (page) => (await printed(page)).split('\n').filter(Boolean).length;

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
    await page.waitForTimeout(600); // past the double-click guard
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');

    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
    await expect(page.locator('#glowscriptOutput')).toHaveCount(1);
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);
  });

  test('a program that finishes returns to Run on its own', async ({ page }) => {
    await run(page, FINITE);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
  });

  test('a compile error returns to Run', async ({ page }) => {
    await run(page, BROKEN);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
  });

  test('Enter on the output-only Stop button stops the program instead of restarting it', async ({ page }) => {
    const res = await page.request.post('/api/trinkets', {
      data: { lang: 'glowscript', code: LOOP, name: 'stop-enter-' + Date.now() },
    });
    expect(res.ok(), 'trinket create should succeed').toBeTruthy();
    const body = await res.json();
    const shortCode = (body.data || body).shortCode;

    await page.goto('/embed/glowscript/' + shortCode + '?outputOnly=true');
    const control = page.locator('button.run-it');
    await expect(control).toBeVisible();

    await control.focus();
    await page.keyboard.press('Enter');                       // Run
    await expect(control).toHaveClass(/run-state-running/);
    await page.waitForTimeout(600);                           // past the double-click guard
    await control.focus();
    await page.keyboard.press('Enter');                       // Stop
    await expect(control).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await page.waitForTimeout(1_500);
    await expect(control, 'Stop must not restart the program').not.toHaveClass(/run-state-/);
  });
});
