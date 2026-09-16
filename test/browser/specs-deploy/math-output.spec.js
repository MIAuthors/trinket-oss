const { test, expect } = require('@playwright/test');

// Typeset SymPy output (#240), against a real deploy.
//
// The unit tests cover the AST wrap and the classifier as pure functions. What
// they cannot show is the thing the feature IS: that a bare SymPy expression
// becomes rendered mathematics in a browser, in order with print output. That
// needs Pyodide, SymPy and KaTeX all actually loading.
//
// Skips unless features.mathOutput is on, so it is inert on deploys that have
// not enabled it. It NO LONGER skips on worker deploys: #288 implemented the
// worker half, and this spec is the positive control for it. Before #288 the
// skip was hiding the one place the feature was broken — flag-on and flag-off
// produced identical output there, so nothing could tell.
async function editorRun(page, path, code) {
  await page.goto(path);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}
const consoleText = (page) =>
  page.evaluate(() => document.querySelector('#console-output')?.innerText || '');

test.describe('typeset SymPy output', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/embed/python3');
    // Read the SERVED page, not a guessed JS object path: the embed config is a
    // flat object, and probing window.trinket.config.features.mathOutput made
    // this spec skip silently on a deploy where the feature was in fact ON.
    // A test that skips when it should run is worse than no test.
    const html = await page.content();
    const cfg = {
      math:   /mathOutput\s*:\s*true/.test(html),
      worker: /workerRuntime\s*:\s*true/.test(html)
    };
    // Say WHY out loud. A silent skip is indistinguishable from a pass in the
    // summary line, and this spec did exactly that: it skipped on a deploy where
    // mathOutput was demonstrably ON, because the detection probed the wrong
    // object. "5 skipped" read as fine. Printing the reason makes a broken
    // detector look different from a feature that is simply off.
    if (!cfg.math) console.log('  [math-output] SKIP: mathOutput is off on this deploy');
    // The runtime is NOT a skip condition any more, but it is still worth
    // naming: the two runtimes reach the same cards by different routes (a
    // direct JS call on the page, a posted `rich` message from the worker), so
    // a failure reads very differently depending on which one ran.
    if (cfg.math) {
      console.log('  [math-output] RUNNING: mathOutput on, ' +
                  (cfg.worker ? 'WORKER' : 'main-thread') + ' deploy');
    }
    test.skip(!cfg.math, 'features.mathOutput is off on this deploy');
  });

  test('a bare SymPy expression renders as mathematics', async ({ page }) => {
    await editorRun(page, '/embed/python3',
      'from sympy import symbols, Integral, sqrt\n' +
      'x = symbols("x")\n' +
      'print("BEFORE")\n' +
      'Integral(sqrt(1/x), x)\n' +
      'print("AFTER")\n');

    // KaTeX renders into .katex; that element existing is the proof the whole
    // chain worked — Pyodide, SymPy, the AST hook, the sink and the renderer.
    await expect(page.locator('#console-output .katex').first(),
      'a bare SymPy expression should typeset, not print a repr')
      .toBeVisible({ timeout: 180_000 });

    // Interleaving is the point: the card must appear BETWEEN the two prints,
    // not merely somewhere on the page. Asserting only BEFORE < AFTER passes
    // even if the card lands at the very end, which is the specific way the
    // worker could have failed: `rich` and `stdout` are separate messages there
    // and stdout is batched, so program order is a property to prove, not to
    // assume. The card carries an echo of the source line, which is what makes
    // its position findable in the console text.
    const text = await consoleText(page);
    expect(text).toContain('BEFORE');
    expect(text).toContain('AFTER');
    const card = text.indexOf('Integral(sqrt(1/x), x)');
    expect(card, 'the card should echo the source line it came from').toBeGreaterThan(-1);
    expect(card, 'the card must not be hoisted above the print that precedes it')
      .toBeGreaterThan(text.indexOf('BEFORE'));
    expect(card, 'the card must not sink below the print that follows it')
      .toBeLessThan(text.indexOf('AFTER'));
  });

  test('display() typesets instead of raising (#288)', async ({ page }) => {
    // The documented escape hatch, and the half that FAILED LOUDLY on the
    // worker before #288: `display` is installed as a builtin by
    // _trinket_display.install(), which only the main thread called, so a
    // worker run raised NameError and halted the program at that line.
    await editorRun(page, '/embed/python3',
      'from sympy import symbols, Integral, sqrt\n' +
      'x = symbols("x")\n' +
      'display(Integral(sqrt(1/x), x))\n' +
      'print("AFTER")\n');

    await expect(page.locator('#console-output .katex').first(),
      'display() should typeset its argument')
      .toBeVisible({ timeout: 180_000 });

    const text = await consoleText(page);
    expect(text, 'display() must not raise').not.toContain('NameError');
    expect(text, 'the program must keep running past the display() call')
      .toContain('AFTER');
  });

  test('a non-typesettable value stays silent, as a script does', async ({ page }) => {
    // The compatibility guarantee: existing trinkets behave identically.
    await editorRun(page, '/embed/python3', '42\n"a string"\nprint("ONLY THIS")\n');
    await expect(async () => {
      expect(await consoleText(page)).toContain('ONLY THIS');
    }).toPass({ timeout: 180_000 });
    expect(await page.locator('#console-output .katex').count(),
      'ints and strings must not typeset').toBe(0);
  });
});
