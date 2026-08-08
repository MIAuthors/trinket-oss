const { test, expect } = require('@playwright/test');

// Issue #107: a one-line mistake produced twelve lines of output, nine of them
// Pyodide's own machinery, printed BEFORE the student's actual error. Reported by
// a faculty member testing with students — it reliably reads as "did I break the
// system?"
//
// These run in a browser because the input is a real PythonError traceback: the
// exact frame layout is produced by the runtime, not by us, so asserting against
// a handwritten sample would only test the sample.
test.describe('Python traceback readability (#107)', () => {
  async function runCode(page, code) {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, code);
    await page.locator('.run-it').first().click();
  }

  async function output(page) {
    return page.evaluate(() => document.querySelector('#outputContainer')?.innerText || '');
  }

  test('hides Pyodide internals and keeps the real error', async ({ page }) => {
    // The reported case, verbatim.
    await runCode(page, 'a = "hi"\nprint(int(a) + 5)');

    await expect(async () => {
      const text = await output(page);
      expect(text, 'the actual error must still be shown').toContain('ValueError');
      expect(text).toContain('invalid literal for int()');
      // The noise: none of these belong in front of a student.
      expect(text, 'runtime frames must be hidden').not.toContain('_pyodide');
      expect(text).not.toContain('_base.py');
      expect(text).not.toContain('eval_code_async');
      expect(text).not.toContain('run_async');
      expect(text).not.toContain('CodeRunner');
    }).toPass({ timeout: 90_000 });
  });

  test('names the user file instead of an empty File ""', async ({ page }) => {
    await runCode(page, 'x = 1\nraise ValueError("boom")');

    await expect(async () => {
      const text = await output(page);
      expect(text).toContain('ValueError');
      expect(text, 'the frame should name the file').toContain('main.py');
      expect(text, 'the empty filename was part of the confusion').not.toContain('File ""');
    }).toPass({ timeout: 90_000 });
  });

  test('keeps the line number so the student can find the mistake', async ({ page }) => {
    // Trimming must not throw away the one navigational clue in the traceback.
    await runCode(page, '\n\n\nraise RuntimeError("here")');

    await expect(async () => {
      const text = await output(page);
      expect(text).toContain('RuntimeError');
      expect(text).toMatch(/line \d+/);
    }).toPass({ timeout: 90_000 });
  });

  test('a syntax error still renders usefully', async ({ page }) => {
    // SyntaxError has a different shape (caret line, no user frames) and must not
    // be mangled or emptied by the filter.
    await runCode(page, 'print("unclosed"\n');

    await expect(async () => {
      const text = await output(page);
      expect(text).toContain('SyntaxError');
      expect(text).not.toContain('_pyodide');
    }).toPass({ timeout: 90_000 });
  });

  test('an error raised inside a user function keeps that frame', async ({ page }) => {
    // Multi-frame case: the student's own call stack is the useful part and must
    // survive, including the function name.
    await runCode(page, 'def boom():\n    return 1/0\n\nboom()');

    await expect(async () => {
      const text = await output(page);
      expect(text).toContain('ZeroDivisionError');
      expect(text, "the user's own frame should remain").toContain('in boom');
      expect(text).not.toContain('_pyodide');
    }).toPass({ timeout: 90_000 });
  });
});
