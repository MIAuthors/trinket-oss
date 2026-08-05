const { test, expect } = require('@playwright/test');

// Golden path the HTTP `flow` harness can't see: the New Trinket editor is a
// client-side ACE surface loaded from /embed/{lang}. These guard the exact bug
// that shipped this week — getDefaultTrinket's bare reply() resolving to the
// pre-handler shim object, which made the "blank" editor load the last trinket's
// draft (Mongo) or 500 (Firestore). Runs authenticated (global-setup).
test.describe('New Trinket editor (python3)', () => {
  test('opens a BLANK editor — no stale code from a previous trinket', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();

    const content = await page.evaluate(() => {
      const el = document.querySelector('.ace_editor');
      return el && el.env && el.env.editor ? el.env.editor.getValue() : '<<no editor>>';
    });
    expect(content.trim()).toBe('');
  });

  test('runs python code and shows its output', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();

    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue("print('hello playwright 4242')", 1);
    });
    await page.locator('.run-it').first().click();

    // Pyodide downloads + boots on first Run (slow); stdout lands in the runner.
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        if (!out) return '';
        let t = out.innerText || '';
        for (const f of out.querySelectorAll('iframe')) {
          try { t += '\n' + (f.contentDocument?.body?.innerText || ''); } catch (e) {}
        }
        return t;
      });
      expect(text).toContain('hello playwright 4242');
    }).toPass({ timeout: 90_000 });
  });
});
