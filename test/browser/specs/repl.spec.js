const { test, expect } = require('@playwright/test');

// SPIKE (#109): does a Pyodide-backed REPL actually work when wired to jq-console?
// These run against a live stack because that is the only way to answer it —
// PyodideConsole's behaviour through a PyProxy cannot be checked by inspection.
//
// The last two tests are the ones that matter most: they assert the spike did not
// disturb the two systems it sits next to (console.input(), and the ordinary
// Run-a-program path that owns VPython rate() cancellation).
test.describe('Pyodide REPL (#109 spike)', () => {
  async function replPrompt(page) {
    await expect(page.locator('#console-output')).toBeVisible({ timeout: 90_000 });
    // The banner is written once Pyodide has booted and the prompt is armed.
    await expect(async () => {
      const text = await page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
      expect(text).toContain('on Pyodide');
    }).toPass({ timeout: 90_000 });
  }

  async function typeLine(page, line) {
    await page.locator('#console-output').click();
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  }

  async function consoleText(page) {
    return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
  }

  test('evaluates an expression and prints its repr', async ({ page }) => {
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, '6*7');

    await expect(async () => {
      expect(await consoleText(page)).toContain('42');
    }).toPass({ timeout: 60_000 });
  });

  test('keeps state between statements', async ({ page }) => {
    // The point of a REPL: the namespace persists.
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, 'x = 5');
    await typeLine(page, 'x + 1');

    await expect(async () => {
      expect(await consoleText(page)).toContain('6');
    }).toPass({ timeout: 60_000 });
  });

  test('continues a multi-line block instead of executing it early', async ({ page }) => {
    // Exercises the continuation callback (codeop.compile_command): `for` alone
    // must NOT execute, and the loop must run once the blank line closes it.
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, 'for i in range(3):');
    await typeLine(page, '    print("n", i)');
    await typeLine(page, '');

    await expect(async () => {
      const text = await consoleText(page);
      expect(text).toContain('n 0');
      expect(text).toContain('n 2');
      expect(text).not.toContain('SyntaxError');
    }).toPass({ timeout: 60_000 });
  });

  test('reports an error without killing the prompt', async ({ page }) => {
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, 'int("hi")');
    await expect(async () => {
      expect(await consoleText(page)).toContain('ValueError');
    }).toPass({ timeout: 60_000 });

    await typeLine(page, '1+1');   // prompt must still be alive
    await expect(async () => {
      expect(await consoleText(page)).toContain('2');
    }).toPass({ timeout: 60_000 });
  });

  test('REGRESSION: console.input() still works at the prompt', async ({ page }) => {
    // console.input() drives jqconsole.Input(), which cannot coexist with an
    // ACTIVE jqconsole.Prompt. The loop is designed so the prompt is consumed
    // before evaluation begins — this proves that holds in practice.
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, 'import console');
    await typeLine(page, 'name = console.input("who? ")');
    await page.waitForTimeout(1500);      // let the input field open
    await typeLine(page, 'Ada');
    await typeLine(page, 'name');

    await expect(async () => {
      const text = await consoleText(page);
      expect(text).toContain('who?');
      expect(text).toContain('Ada');
    }).toPass({ timeout: 90_000 });
  });

  test('REGRESSION: the ordinary Run path is unaffected', async ({ page }) => {
    // Without runMode=console nothing about the normal editor/Run flow changes —
    // this is the path that owns VPython rate() cancellation and the async
    // transform, neither of which the REPL touches.
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue('print("ordinary run", 1+1)', 1);
    });
    await page.locator('.run-it').first().click();

    await expect(async () => {
      const text = await page.evaluate(() => document.querySelector('#outputContainer')?.innerText || '');
      expect(text).toContain('ordinary run 2');
    }).toPass({ timeout: 90_000 });
  });
});
