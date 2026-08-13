const { test, expect } = require('@playwright/test');

// #108's runtime override was previously offered only on the Link dialog (see
// share-runtime-option.spec.js). This was an oversight rather than a decision,
// so it is now offered on the Embed dialog too, using the same gate
// (config.app.runtimeOption) and the same option labels.
test.describe('Embed dialog: runtime option (#108)', () => {
  async function createTrinket(page, lang, code) {
    const res = await page.request.post('/api/trinkets', {
      data: { lang, code, name: 'embed-runtime-' + lang + '-' + Date.now() },
    });
    expect(res.ok(), 'trinket create should succeed').toBeTruthy();
    const body = await res.json();
    return (body.data || body).shortCode;
  }

  // The live Embed dialog is #embedModal from lib/views/includes/shareModals.html
  // (Share > Embed on the library detail page).
  async function openEmbedModal(page, shortCode) {
    await page.goto('/library/trinkets/' + shortCode);
    await page.locator('a[data-dropdown="shareDropdown"]').click();
    await page.locator('#shareDropdown a:has-text("Embed")').click();
    await expect(page.locator('#embedModal')).toBeVisible();
  }

  test('the dialog offers the choice for python3 and writes runtime=worker into the iframe snippet', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("embed runtime")');
    await openEmbedModal(page, shortCode);

    const choice    = page.locator('#runtimeOptionEmbed');
    const embedCode = page.locator('#embedCode');
    await expect(choice).toBeVisible();
    await expect(embedCode).toContainText('/embed/python3/' + shortCode);
    expect(await embedCode.innerText()).not.toContain('runtime=');

    await choice.selectOption('worker');
    await expect(embedCode).toContainText('runtime=worker');

    // Back to the default: the parameter must come off again, not linger.
    await choice.selectOption('');
    await expect(embedCode).not.toContainText('runtime=');
  });

  // The other direction. It does nothing on a deploy with the flag off (the main
  // thread is already the default), but once a deploy turns the worker ON this is
  // the only escape hatch an author has that isn't hand-editing the snippet.
  test('writes runtime=main, the escape hatch for a worker-enabled deploy', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("embed runtime main")');
    await openEmbedModal(page, shortCode);

    const choice    = page.locator('#runtimeOptionEmbed');
    const embedCode = page.locator('#embedCode');
    await expect(choice).toBeVisible();

    await choice.selectOption('main');
    await expect(embedCode).toContainText('runtime=main');
    expect(await embedCode.innerText()).not.toContain('runtime=worker');

    // Switching between the two must replace the value, not accumulate params.
    await choice.selectOption('worker');
    await expect(embedCode).toContainText('runtime=worker');
    expect(await embedCode.innerText()).not.toContain('runtime=main');

    await choice.selectOption('');
    await expect(embedCode).not.toContainText('runtime=');
  });

  test('the choice is hidden for a trinket type that ignores it (glowscript)', async ({ page }) => {
    // ?runtime= is read only by the Pyodide embed. Offering it on glowscript
    // would be a control that silently does nothing.
    const shortCode = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');
    await openEmbedModal(page, shortCode);

    await expect(page.locator('#embedCode')).toContainText('/embed/glowscript/' + shortCode);
    await expect(page.locator('#embedRuntimeOption')).toBeHidden();
    // The calculator option is visible here — proving the assertion above is
    // about this control's own gate, not about the modal failing to render.
    await expect(page.locator('#embedCalculatorOption')).toBeVisible();
  });
});
