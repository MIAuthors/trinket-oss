const { test, expect } = require('@playwright/test');

// Clear memory is intentionally different from Clear output: it preserves the
// transcript, but the next program must not be able to read a variable defined
// by an earlier Run.
test('Clear memory discards variables from the main-thread Python interpreter', async ({ page }) => {
  await page.goto('/embed/python3?runtime=main');
  await expect(page.locator('.ace_editor')).toBeVisible();

  await page.evaluate(() => {
    document.querySelector('.ace_editor').env.editor.setValue('remembered = 42\nprint(remembered)', 1);
  });
  await page.locator('.run-it').first().click();

  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain('42');
  }).toPass({ timeout: 90_000 });

  await page.evaluate(() => {
    document.querySelector('.ace_editor').env.editor.setValue('print(remembered)', 1);
  });
  await page.locator('.clear-memory-it').click();

  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain('[Python memory cleared.]');
  }).toPass({ timeout: 30_000 });

  await page.locator('.run-it').first().click();
  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain("NameError: name 'remembered' is not defined");
  }).toPass({ timeout: 90_000 });
});

test('Clear memory restarts an active Python console prompt', async ({ page }) => {
  await page.goto('/embed/python3?runtime=main');
  await expect(page.locator('.ace_editor')).toBeVisible();

  await page.evaluate(() => {
    $('#editor').trigger('trinket.code.console', { action: 'code.console' });
  });

  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain('>>>');
  }).toPass({ timeout: 90_000 });

  await page.locator('.clear-memory-it').click();
  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain('[Python memory cleared — console session reset]');
    expect(text).toContain('>>>');
  }).toPass({ timeout: 30_000 });
});
