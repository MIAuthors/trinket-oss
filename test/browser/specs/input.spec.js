const { test, expect } = require('@playwright/test');

// input() used to raise `OSError: [Errno 29] I/O error` in Pyodide because the
// runner configured stdout/stderr but never stdin — breaking every intro-course
// trinket that reads input (reported by a Billerica HS teacher). The fix
// overrides the input() builtin to read from a browser prompt. This exercises it
// end-to-end: a program that reads input() must pop a dialog and use the answer,
// with no I/O error.
test.describe('Pyodide input()', () => {
  test('input() reads from the prompt dialog instead of raising an I/O error', async ({ page }) => {
    // Answer every prompt() dialog with a known value.
    page.on('dialog', (dialog) => dialog.accept('Ada'));

    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();

    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'name = input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    // Pyodide downloads + boots on first Run (slow); stdout lands in the runner.
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        if (!out) return '';
        let t = out.innerText || '';
        for (const f of out.querySelectorAll('iframe')) {
          try { t += '\n' + (f.contentDocument?.body?.innerText || ''); } catch (e) {}
        }
        return t;
      });
      expect(text).toContain('hi Ada');          // input() returned the dialog's value
      expect(text).not.toContain('I/O error');   // the old OSError [Errno 29] is gone
    }).toPass({ timeout: 90_000 });
  });

  test('the input() prompt is echoed to the console BEFORE the dialog opens', async ({ page }) => {
    // When the prompt dialog appears, the prompt text must already be visible in
    // the console (the old bug: print(prompt, end="") was buffered, so nothing
    // showed until after the dialog was dismissed).
    //
    // Note on technique: we can't read DOM state from inside the page.on('dialog')
    // handler via page.evaluate() — a native window.prompt() blocks the page's JS
    // thread for as long as the dialog is open, and Playwright's evaluate() (a CDP
    // Runtime.evaluate call) queues behind that block, so it never resolves until
    // *after* the dialog is dismissed (confirmed via isolated repro; this is a
    // Playwright/Chromium limitation, not app behavior). Instead we install a
    // window.prompt override via addInitScript that captures the console text
    // synchronously, in-page, at the exact moment prompt() is called — before the
    // real dialog blocks anything — then read the captured value back afterward.
    await page.addInitScript(() => {
      const nativePrompt = window.prompt;
      window.prompt = function(...args) {
        const out = document.querySelector('#outputContainer');
        window.__consoleTextAtPromptCall = out ? (out.innerText || '') : '';
        return nativePrompt.apply(window, args);
      };
    });
    page.on('dialog', (dialog) => dialog.accept('Ada'));

    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'name = input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    await expect(async () => {
      const consoleTextAtPromptCall = await page.evaluate(() => window.__consoleTextAtPromptCall);
      expect(consoleTextAtPromptCall).not.toBeUndefined();
      expect(consoleTextAtPromptCall).toContain('your name?'); // echoed before the modal
    }).toPass({ timeout: 90_000 });
  });
});
