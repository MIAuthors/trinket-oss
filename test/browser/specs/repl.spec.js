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

  test('the Share dialog\'s "Interactive console only" option reaches the REPL', async ({ page }) => {
    // The dialog emits runOption=console (NOT runMode=console): the server keeps
    // it as runOption, so its runMode fallback never fires. If the REPL keyed on
    // runMode alone, the dialog's option would still be dead — which is the
    // complaint in #109. This asserts the advertised control actually works.
    await page.goto('/embed/python3?runOption=console&start=result');
    await replPrompt(page);

    await typeLine(page, '2**10');

    await expect(async () => {
      expect(await consoleText(page)).toContain('1024');
    }).toPass({ timeout: 60_000 });
  });

  // --- Found by Steve's manual smoke test of the console on :3001 -------------
  // Both defects are in what the REPL PRINTS rather than what it evaluates,
  // which is why every test above — all of which check evaluation — stayed green.

  test('output is legible: the light-background console palette is applied', async ({ page }) => {
    // `.jqconsole-output` is WHITE by default — the palette for the dark console
    // a running program draws into. The light REPL palette lives behind
    // `.console-mode`, which the Skulpt REPL sets and this one did not, leaving
    // white text on the #f9f9f9 REPL background.
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    expect(await page.evaluate(() =>
      document.getElementById('console-output').classList.contains('console-mode')
    )).toBe(true);

    const color = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'jqconsole-output';
      document.querySelector('.jqconsole').appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(color).not.toBe('rgb(255, 255, 255)');
  });

  test('angle brackets in output survive rendering (repr)', async ({ page }) => {
    // The console wrote unescaped HTML, so every <...> in Python text was parsed
    // as a tag and vanished — an object's repr disappeared completely.
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, 'class Foo: pass');
    await page.keyboard.press('Enter');          // blank line closes the block
    await typeLine(page, 'Foo()');

    await expect(async () => {
      expect(await consoleText(page)).toMatch(/<__main__\.Foo object at 0x[0-9a-f]+>/);
    }).toPass({ timeout: 60_000 });
  });

  test('markup in an exception message is shown, not executed', async ({ page }) => {
    // The same unescaped write, seen as an injection rather than a rendering bug.
    await page.goto('/embed/python3?runMode=console&start=result');
    await replPrompt(page);

    await typeLine(page, 'raise ValueError(\'<img src=x onerror="window.__pwned=1">\')');

    await expect(async () => {
      expect(await consoleText(page)).toContain('<img src=x onerror="window.__pwned=1">');
    }).toPass({ timeout: 60_000 });

    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.evaluate(() =>
      document.querySelectorAll('.jqconsole img:not(#powered-by-trinket)').length
    )).toBe(0);
  });

});
