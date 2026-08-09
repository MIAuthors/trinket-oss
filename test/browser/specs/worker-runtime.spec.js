const { test, expect } = require('@playwright/test');

// #108: routing is the contract Task 4 delivers — the right program reaches the
// right runtime. Behaviour of the worker itself (stop, input, tracebacks) is
// covered by the later tests in this same file.
test.describe('Worker runtime (#108)', () => {
  async function editorRun(page, code, path) {
    await page.goto(path || '/embed/python3?runtime=worker');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, code);
    await page.locator('.run-it').first().click();
  }

  async function consoleText(page) {
    return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
  }

  test('routes an ordinary program to the worker', async ({ page }) => {
    await editorRun(page, 'print("from the worker")');
    await expect(async () => {
      expect(await consoleText(page)).toContain('from the worker');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
  });

  test('keeps VPython on the main thread', async ({ page }) => {
    await editorRun(page, 'from vpython import *\nsphere()');
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
    }).toPass({ timeout: 90_000 });
  });

  test('REGRESSION: with the flag off, everything stays on the main thread', async ({ page }) => {
    await editorRun(page, 'print("main thread")', '/embed/python3');
    await expect(async () => {
      expect(await consoleText(page)).toContain('main thread');
    }).toPass({ timeout: 90_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });

  test('input() prompts in order and resumes with the answer', async ({ page }) => {
    // The prompt must appear BEFORE the answer. Printing it from Python left it
    // in Pyodide's batched stdout — which flushes only on a newline — so it
    // surfaced after the student had already typed.
    await editorRun(page, 'name = input("who? ")\nprint("hello", name)');

    await expect(page.locator('#console-output .jqconsole-input')).toBeVisible({ timeout: 120_000 });
    await expect(async () => {
      expect(await consoleText(page)).toContain('who?');
    }).toPass({ timeout: 30_000 });

    await page.locator('textarea:not(.ace_text-input)').pressSequentially('Ada');
    await page.locator('textarea:not(.ace_text-input)').press('Enter');

    await expect(async () => {
      const text = await consoleText(page);
      expect(text).toContain('hello Ada');
      expect(text.indexOf('who?')).toBeLessThan(text.indexOf('hello Ada'));
    }).toPass({ timeout: 30_000 });
  });


  // --- the headline claims of #108 -----------------------------------------
  // Neither can be proved by a unit test: both are about whether the UI thread
  // is blocked, which only a real browser can answer.

  test('THE POINT: the page stays responsive during `while True: pass`', async ({ page }) => {
    await editorRun(page, 'while True:\n    pass');
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 120_000 });

    // Let the loop get properly under way, then prove the main thread still
    // runs JavaScript. On the main-thread runtime this evaluate() never returns.
    await page.waitForTimeout(3000);
    const alive = await page.evaluate(() => { document.title = 'alive'; return document.title; });
    expect(alive).toBe('alive');
  });

  test('THE POINT: Stop kills `while True: pass`', async ({ page }) => {
    await editorRun(page, 'while True:\n    pass');
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(2000);

    await page.locator('.stop-it').first().click();

    await expect(async () => {
      expect(await consoleText(page)).toContain('[stopped]');
    }).toPass({ timeout: 30_000 });
    // No "cannot be stopped" apology: terminate() is unconditional.
    expect(await consoleText(page)).not.toContain('cannot be');
    await expect(page.locator('.stop-it')).toBeHidden({ timeout: 30_000 });
  });

  test('a program still runs after a stop (replacement worker)', async ({ page }) => {
    await editorRun(page, 'while True:\n    pass');
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 120_000 });
    await page.locator('.stop-it').first().click();
    await expect(page.locator('.stop-it')).toBeHidden({ timeout: 30_000 });

    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue('print("second run")', 1);
    });
    await page.locator('.run-it').first().click();

    await expect(async () => {
      expect(await consoleText(page)).toContain('second run');
    }).toPass({ timeout: 120_000 });
  });

  test('a traceback from the worker is filtered like the main thread (#107)', async ({ page }) => {
    // The worker sends the RAW traceback; the page applies formatPythonTraceback
    // and escapeConsoleHtml. If the worker's frames differ from the in-window
    // ones, this is where it shows.
    await editorRun(page, 'print(int("hi"))');

    await expect(async () => {
      const text = await consoleText(page);
      expect(text).toContain('ValueError');
      expect(text).toContain('invalid literal for int()');
      expect(text).not.toMatch(/_pyodide|python\d*\.zip|_base\.py|CodeRunner|eval_code_async/);
    }).toPass({ timeout: 120_000 });
  });


  test('a matplotlib figure from the worker is displayed', async ({ page }) => {
    // A worker has no document, so the webagg backend the main thread uses
    // cannot work. It renders headlessly with Agg and ships a PNG.
    await editorRun(page, [
      'import matplotlib.pyplot as plt',
      'plt.plot([1, 2, 3], [2, 4, 9])',
      'plt.show()'
    ].join('\n'));

    // Either shape is acceptable: the interactive mpl.js canvas, or the static
    // PNG fallback if the frontend could not load. A plot must ALWAYS appear.
    await expect(page.locator('#graphic .worker-figure')).toBeVisible({ timeout: 240_000 });

    const shape = await page.evaluate(() => {
      const host = document.querySelector('#graphic .mpl-figure');
      if (host && host.querySelector('canvas.mpl-canvas')) return 'interactive';
      return document.querySelector('#graphic img.worker-figure') ? 'png' : 'none';
    });
    expect(['interactive', 'png']).toContain(shape);

    if (shape === 'interactive') {
      // The toolbar is the point of the interactive path (home/back/forward/
      // pan/zoom/download) — its absence means we silently lost it.
      expect(await page.evaluate(() =>
        document.querySelectorAll('#graphic .mpl-figure button').length
      )).toBeGreaterThanOrEqual(5);
      // The canvas element exists before its first frame arrives over the
      // channel, so poll for actual ink rather than checking once.
      await expect(async () => {
        const ink = await page.evaluate(() => {
          const c = document.querySelector('#graphic .mpl-figure canvas.mpl-canvas');
          if (!c || !c.width) return 0;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0 && d[i] < 250) n++; }
          return n;
        });
        expect(ink, 'the plot must actually be drawn').toBeGreaterThan(500);
      }).toPass({ timeout: 60_000 });
    }
  });

  test('a figure left open without show() is still flushed', async ({ page }) => {
    // Students routinely omit plt.show(); the main thread flushes for them, so
    // the worker must too or the plot silently vanishes.
    await editorRun(page, [
      'import matplotlib.pyplot as plt',
      'plt.plot([1, 2, 3])'
    ].join('\n'));

    await expect(page.locator('#graphic .worker-figure')).toBeVisible({ timeout: 240_000 });
  });

  test('numpy is installed in the worker too', async ({ page }) => {
    // The worker has its own interpreter, so the main thread's
    // loadPackagesFromImports does nothing for it.
    await editorRun(page, 'import numpy as np\nprint(np.arange(3).sum())');
    await expect(async () => {
      expect(await consoleText(page)).toContain('3');
    }).toPass({ timeout: 240_000 });
  });

});
