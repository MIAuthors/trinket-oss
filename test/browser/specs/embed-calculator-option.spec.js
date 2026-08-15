const { test, expect } = require('@playwright/test');

// The calculator layout option was previously offered only on the Link dialog
// (see share-calculator-option.spec.js). This was an oversight rather than a
// decision, so it is now offered on the Embed dialog too, using the same gate
// (config.app.calculatorOption) and the same option labels.
test.describe('Embed dialog: calculator layout', () => {
  async function createTrinket(page, lang, code) {
    const res = await page.request.post('/api/trinkets', {
      data: { lang, code, name: 'embed-calculator-' + lang + '-' + Date.now() },
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

  test('the dialog offers it for glowscript and writes runMode=calculator into the iframe snippet', async ({ page }) => {
    const shortCode = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');
    await openEmbedModal(page, shortCode);

    const choice     = page.locator('#calculatorOptionEmbed');
    const embedCode  = page.locator('#embedCode');
    await expect(choice).toBeVisible();
    await expect(embedCode).toContainText('/embed/glowscript/' + shortCode);
    expect(await embedCode.innerText()).not.toContain('runMode=');

    await choice.selectOption('calculator');
    await expect(embedCode).toContainText('runMode=calculator');

    // Choosing another option must not drop the layout: every control re-emits
    // the whole query string, so this is where a lost parameter would show.
    await page.locator('#displayOptionEmbed').selectOption('outputOnly');
    await expect(embedCode).toContainText('runMode=calculator');
    await expect(embedCode).toContainText('outputOnly=true');

    // Back to the standard layout: the parameter comes off again.
    await choice.selectOption('');
    await expect(embedCode).not.toContainText('runMode=');
  });

  test('it is hidden for a trinket type that does not implement it (python3)', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("no calculator here")');
    await openEmbedModal(page, shortCode);

    await expect(page.locator('#embedCode')).toContainText('/embed/python3/' + shortCode);
    await expect(page.locator('#embedCalculatorOption')).toBeHidden();
    // The modal did render — this is the control's own gate, not a blank dialog.
    await expect(page.locator('#embedRunOption')).toBeVisible();
  });
});
