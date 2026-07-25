const { test, expect } = require('@playwright/test');

// WebVPython (glowscript) is the pure-client-side, WebGL-rendered class of trinket
// — exactly what HTTP tests can't touch and where the blank-snapshot bug lives.
// This proves headless Chrome (SwiftShader) can actually render the scene, which
// is the prerequisite for a future snapshot-not-blank assertion.
test.describe('WebVPython editor (glowscript)', () => {
  test('opens a blank editor', async ({ page }) => {
    await page.goto('/embed/glowscript');
    await expect(page.locator('.ace_editor')).toBeVisible();
    const content = await page.evaluate(() =>
      document.querySelector('.ace_editor').env.editor.getValue());
    expect(content.trim()).toBe('');
  });

  test('runs a scene and renders a WebGL canvas', async ({ page }) => {
    await page.goto('/embed/glowscript');
    await expect(page.locator('.ace_editor')).toBeVisible();

    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor
        .setValue('from vpython import *\nsphere(color=color.red)\n', 1);
    });
    await page.locator('.run-it').first().click();

    // glowscript renders into a sandboxed cross-origin iframe (#glowscriptOutput),
    // so page.evaluate/contentDocument can't reach it — but Playwright's frame API
    // can. Walk every frame for a sized <canvas> (the WebGL scene).
    await expect(async () => {
      let rendered = false;
      for (const frame of page.frames()) {
        if (await frame.locator('canvas').count().catch(() => 0) === 0) continue;
        const sized = await frame.locator('canvas').first()
          .evaluate((c) => c.width > 1 && c.height > 1).catch(() => false);
        if (sized) { rendered = true; break; }
      }
      expect(rendered).toBe(true);
    }).toPass({ timeout: 90_000 });
  });
});
