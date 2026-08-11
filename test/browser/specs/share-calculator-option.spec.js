const { test, expect } = require('@playwright/test');

// runMode=calculator has been fully implemented for years (lib/views/embed/
// base.html, lib/views/embed/glowscript.html, public/js/embed/glowscript.js) and
// offered nowhere in the UI. runMode already flows page URL -> controller ->
// iframe allowlist, so the dialog entry is the whole feature — but the layout it
// asks for still has to arrive, which is what the second half of this file pins.
test.describe('Share dialog: calculator layout', () => {
  async function createTrinket(page, lang, code) {
    const res = await page.request.post('/api/trinkets', {
      data: { lang, code, name: 'share-calculator-' + lang + '-' + Date.now() },
    });
    expect(res.ok(), 'trinket create should succeed').toBeTruthy();
    const body = await res.json();
    return (body.data || body).shortCode;
  }

  // The live Share dialog is #shareModal from lib/views/includes/shareModals.html
  // (Share > Link on the library detail page).
  async function openLinkModal(page, shortCode) {
    await page.goto('/library/trinkets/' + shortCode);
    await page.locator('a[data-dropdown="shareDropdown"]').click();
    await page.locator('#shareDropdown a:has-text("Link")').click();
    await expect(page.locator('#shareModal')).toBeVisible();
  }

  async function embedFrame(page) {
    const handle = await page.waitForSelector('#trinket-iframe');
    const frame = await handle.contentFrame();
    expect(frame, 'the trinket page must render its embed iframe').not.toBeNull();
    return frame;
  }

  test('the dialog offers it for glowscript and writes runMode=calculator', async ({ page }) => {
    const shortCode = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');
    await openLinkModal(page, shortCode);

    const choice   = page.locator('#calculatorOptionLink');
    const shareUrl = page.locator('#shareUrl');
    await expect(choice).toBeVisible();
    await expect(shareUrl).toContainText('/glowscript/' + shortCode);
    expect(await shareUrl.innerText()).not.toContain('runMode=');

    await choice.selectOption('calculator');
    await expect(shareUrl).toContainText('runMode=calculator');

    // Choosing another option must not drop the layout: every control re-emits
    // the whole query string, so this is where a lost parameter would show.
    await page.locator('#displayOptionLink').selectOption('outputOnly');
    await expect(shareUrl).toContainText('runMode=calculator');
    await expect(shareUrl).toContainText('outputOnly=true');

    // Back to the standard layout: the parameter comes off again.
    await choice.selectOption('');
    await expect(shareUrl).not.toContainText('runMode=');
  });

  test('it is hidden for a trinket type that does not implement it (python3)', async ({ page }) => {
    const shortCode = await createTrinket(page, 'python3', 'print("no calculator here")');
    await openLinkModal(page, shortCode);

    await expect(page.locator('#shareUrl')).toContainText('/python3/' + shortCode);
    await expect(page.locator('#shareCalculatorOption')).toBeHidden();
    // The modal did render — this is the control's own gate, not a blank dialog.
    await expect(page.locator('#shareDisplayOptions')).toBeVisible();
  });

  test('runMode=calculator on the trinket page produces the calculator layout', async ({ page }) => {
    const shortCode = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');

    await page.goto('/glowscript/' + shortCode + '?runMode=calculator');
    const src = await page.locator('#trinket-iframe').getAttribute('src');
    expect(src).toContain('runMode=calculator');

    const frame = await embedFrame(page);
    await frame.waitForSelector('body', { timeout: 30_000 });

    // Observed against the live DOM rather than guessed: calculator renders the
    // toggle layout (embed/base.html:72) AND drops the brand menu (:134) and the
    // Help button (embed/glowscript.html:23). mode-toggle alone would not
    // distinguish it from a plain toggleCode share.
    // (The help PANEL's close button is always present, so this counts only the
    // controls that open it — the toolbar button and the left-menu entry.)
    const layout = await frame.evaluate(() => ({
      bodyClass : document.body.className,
      brandMenu : !!document.querySelector('#brand-menu'),
      help      : document.querySelectorAll('[data-action="code.help"][data-data="open"]').length,
    }));
    expect(layout.bodyClass).toContain('mode-toggle');
    expect(layout.brandMenu).toBe(false);
    expect(layout.help).toBe(0);
  });

  test('without the option the standard layout is unchanged', async ({ page }) => {
    const shortCode = await createTrinket(page, 'glowscript', 'from vpython import *\nsphere()\n');

    await page.goto('/glowscript/' + shortCode);
    expect(await page.locator('#trinket-iframe').getAttribute('src')).not.toContain('runMode=');

    const frame = await embedFrame(page);
    await frame.waitForSelector('body', { timeout: 30_000 });

    const layout = await frame.evaluate(() => ({
      bodyClass : document.body.className,
      brandMenu : !!document.querySelector('#brand-menu'),
    }));
    expect(layout.bodyClass).toContain('mode-standard');
    expect(layout.brandMenu).toBe(true);
  });
});
