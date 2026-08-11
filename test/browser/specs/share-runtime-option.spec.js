const { test, expect } = require('@playwright/test');

// #108: the share dialog's runtime option. The value the author picks has to
// survive TWO hops — dialog -> trinket page URL, then trinket page -> the iframe
// src it rebuilds from a fixed allowlist. A parameter missing from that allowlist
// is dropped silently, so the option would look right in the dialog and do
// nothing for the student. That round trip is what these tests exist to pin.
test.describe('Share dialog: runtime option (#108)', () => {
  async function createTrinket(page, lang, code) {
    const res = await page.request.post('/api/trinkets', {
      data: { lang, code, name: 'share-runtime-' + lang + '-' + Date.now() },
    });
    expect(res.ok(), 'trinket create should succeed').toBeTruthy();
    const body = await res.json();
    return (body.data || body).shortCode;
  }

  // The page's iframe is same-origin (/embed/...), so its Frame can be evaluated
  // in directly rather than through a FrameLocator.
  async function embedFrame(page) {
    const handle = await page.waitForSelector('#trinket-iframe');
    const frame = await handle.contentFrame();
    expect(frame, 'the trinket page must render its embed iframe').not.toBeNull();
    return frame;
  }

  async function runInEmbed(frame) {
    await frame.waitForSelector('.ace_editor', { state: 'visible', timeout: 60_000 });
    await frame.locator('.run-it').first().click();
    await expect(async () => {
      expect(await frame.evaluate(() => window.__trinketRuntime)).toBeTruthy();
    }).toPass({ timeout: 120_000 });
  }

  // The live Share dialog is #shareModal from lib/views/includes/shareModals.html,
  // opened from the library detail page's Share > Link menu. (The Angular
  // trinkets/detail/share.html template carries the same fieldsets, but the tab
  // bar that mounts it is commented out in detail.html, so it renders nowhere.)
  async function openLinkModal(page, shortCode) {
    await page.goto('/library/trinkets/' + shortCode);
    await page.locator('a[data-dropdown="shareDropdown"]').click();
    await page.locator('#shareDropdown a:has-text("Link")').click();
    await expect(page.locator('#shareModal')).toBeVisible();
  }

  test('the dialog offers the choice for python3 and writes runtime=worker', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("share runtime")');
    await openLinkModal(page, shortCode);

    const choice   = page.locator('#runtimeOptionLink');
    const shareUrl = page.locator('#shareUrl');
    await expect(choice).toBeVisible();
    await expect(shareUrl).toContainText('/python3/' + shortCode);
    expect(await shareUrl.innerText()).not.toContain('runtime=');

    await choice.selectOption('worker');
    await expect(shareUrl).toContainText('runtime=worker');

    // Back to the default: the parameter must come off again, not linger.
    await choice.selectOption('');
    await expect(shareUrl).not.toContainText('runtime=');
  });

  test('the choice is hidden for a trinket type that ignores it (glowscript)', async ({ page }) => {
    // ?runtime= is read only by the Pyodide embed. Offering it on glowscript
    // would be a control that silently does nothing.
    const shortCode = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');
    await openLinkModal(page, shortCode);

    await expect(page.locator('#shareUrl')).toContainText('/glowscript/' + shortCode);
    await expect(page.locator('#shareRuntimeOption')).toBeHidden();
    // The Run-vs-Console choice is hidden here too — proving the assertion above
    // is about this control's own gate, not about the modal failing to render.
    await expect(page.locator('#shareDisplayOptions')).toBeVisible();
  });

  test('THE TRAP: runtime=worker on the TRINKET PAGE reaches the embed', async ({ page }) => {
    // The share URL is a trinket-page URL, not an embed URL. lib/controllers/
    // trinket.js must read `runtime` off it and the base template must carry it
    // into the iframe src, or the option is inert.
    const shortCode = await createTrinket(page, 'python3', 'print("routed")');

    await page.goto('/python3/' + shortCode + '?runtime=worker');

    const src = await page.locator('#trinket-iframe').getAttribute('src');
    expect(src, 'the iframe src allowlist must carry runtime').toContain('runtime=worker');

    const frame = await embedFrame(page);
    await runInEmbed(frame);

    expect(await frame.evaluate(() => window.__trinketRuntime)).toBe('worker');
    // The REASON proves the query parameter arrived, rather than the deploy flag
    // happening to choose the worker anyway.
    expect(await frame.evaluate(() => window.__trinketRuntimeReason)).toMatch(/query/i);
  });

  test('no option chosen still routes exactly as the deploy config says', async ({ page }) => {
    // Pinned to the CONFIG, not to a literal: the dev stack sets
    // features.workerRuntime: true in config/local.yaml, so an ordinary program
    // with no ?runtime= goes to the worker for reason "default". On a stack with
    // the flag off the same program stays on the main thread — so the expected
    // runtime is derived from the flag the embed itself reports.
    const shortCode = await createTrinket(page, 'python3', 'print("default routing")');

    await page.goto('/python3/' + shortCode);

    const src = await page.locator('#trinket-iframe').getAttribute('src');
    expect(src, 'nothing chosen means no runtime parameter').not.toContain('runtime=');

    const frame = await embedFrame(page);
    await runInEmbed(frame);

    const workerEnabled = await frame.evaluate(() =>
      !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime));
    expect(await frame.evaluate(() => window.__trinketRuntime)).toBe(workerEnabled ? 'worker' : 'main');
    // Whatever it chose, it was NOT because of a query parameter.
    expect(await frame.evaluate(() => window.__trinketRuntimeReason)).not.toMatch(/query/i);
  });
});
