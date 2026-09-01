const { test, expect } = require('@playwright/test');

// #224: the Download item in the embed menu did nothing. The endpoint was
// healthy and the client handler ran without exceptions — the browser was
// simply told not to send the request, because the handler used a form POST
// into a hidden iframe and the embed CSP ends with
// `form-action 'none'; frame-src 'none'`.
//
// Both halves passing individually while the feature is dead is exactly why
// this has to be asserted in a browser, at the level of "a file actually
// arrives". Neither a unit test of the route nor one of the handler would have
// caught it.
const TYPES = ['python3', 'pyodide'];

test.describe('embed Download delivers a file', () => {
  for (const type of TYPES) {
    test(`${type}: clicking Download produces a zip, with no CSP violation`, async ({ page, baseURL }) => {
      const violations = [];
      page.on('console', (m) => {
        const t = m.text();
        if (/Content Security Policy/i.test(t)) violations.push(t.split('\n')[0]);
      });

      await page.goto(`/embed/${type}?code=${encodeURIComponent('print("hi")\n')}`,
        { waitUntil: 'networkidle' });

      await page.locator('#menu-button, .menu-button, [class*="hamburger"]').first()
        .click({ timeout: 10_000 });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        page.locator('a:has-text("Download")').first().click(),
      ]);

      expect(download.suggestedFilename(), 'the download should be a zip').toMatch(/\.zip$/);

      // The CSP is deliberate and stays as authored — the fix was to stop
      // needing a form and a frame, not to widen the policy. If a future change
      // reaches for form-action/frame-src again, this fails.
      expect(violations, 'download must not require relaxing the embed CSP: ' + violations.join(' | '))
        .toHaveLength(0);
    });
  }

  test('a failed download says so instead of doing nothing', async ({ page }) => {
    // The point of moving off the hidden iframe was to give failures somewhere
    // to go — the old design routed them into the frame, which is why a blocked
    // download showed nothing at all. That catch path was untested in BOTH
    // independent fixes for #224 (mine and #225), so it is asserted here.
    // Flagged by @drewsday on #227.
    await page.goto(`/embed/python3?code=${encodeURIComponent('print("hi")\n')}`,
      { waitUntil: 'networkidle' });

    // Stub the endpoint as failing, leaving the client path exactly as shipped.
    await page.route('**/api/trinkets/download', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'nope' }));

    await page.locator('#menu-button, .menu-button, [class*="hamburger"]').first()
      .click({ timeout: 10_000 });
    await page.locator('a:has-text("Download")').first().click();

    await expect(page.locator('text=/could not be prepared/i').first(),
      'a failed download must surface a message, not fail silently')
      .toBeVisible({ timeout: 15_000 });
  });
});
