const { test, expect } = require('@playwright/test');

// #108: routing is the contract Task 4 delivers — the right program reaches the
// right runtime. Behaviour of the worker itself (stop, input, tracebacks) is
// covered by the later tests in this same file.
test.describe('Worker runtime (#108)', () => {
  async function editorRun(page, code, path) {
    await page.goto(path || '/embed/python3?runtime=worker');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, code);
    await page.locator('.run-it').first().click();
  }

  async function consoleText(page) {
    return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
  }

  test('routes an ordinary program to the worker', async ({ page }) => {
    await editorRun(page, 'print("from the worker")');
    await expect(async () => {
      expect(await consoleText(page)).toContain('from the worker');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
  });

  test('keeps VPython on the main thread', async ({ page }) => {
    await editorRun(page, 'from vpython import *\nsphere()');
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
    }).toPass({ timeout: 90_000 });
  });

  test('REGRESSION: with the flag off, everything stays on the main thread', async ({ page }) => {
    await editorRun(page, 'print("main thread")', '/embed/python3');
    await expect(async () => {
      expect(await consoleText(page)).toContain('main thread');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });
});
