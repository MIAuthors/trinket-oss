const { test, expect } = require('@playwright/test');

// Issue #6: importing was reachable only by digging into Account settings. A user
// who had exported their entire trinket.io library concluded there was no way in
// at all (trinketapp#26) — the feature existed, the path to it didn't.
//
// The My Trinkets page is where someone with an exported zip goes looking, so the
// button belongs there. It is an Angular SPA with no server-side user context, so
// it reads a `canImport` flag injected into the page config — gated identically
// to GET /account/import, because a button that bounces the user to
// /account/profile would be worse than no button.
//
// Runs authenticated (global-setup).
test.describe('Import button on My Trinkets (#6)', () => {
  test('is visible on the My Trinkets toolbar', async ({ page }) => {
    await page.goto('/library/trinkets');
    await expect(page.locator('#import-trinkets-section a')).toBeVisible({ timeout: 30_000 });
  });

  test('leads to a page that actually serves for this user', async ({ page }) => {
    // The failure mode this gating exists to prevent: advertising a link whose
    // route then rejects the same user.
    await page.goto('/library/trinkets');
    const link = page.locator('#import-trinkets-section a');
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click();

    await expect(page).toHaveURL(/\/account\/import/, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(/Import/i);
  });

  test('the menu entry still works too', async ({ page }) => {
    // Toolbar covers "I'm looking at my trinkets"; the menu covers "anywhere
    // else in the app". Both should exist.
    await page.goto('/library/trinkets');
    const html = await page.content();
    expect(html).toContain('/account/import');
  });
});
