const { test, expect } = require('@playwright/test');

// RUNTIME PINNED. These tests were written against the in-window Pyodide and
// assert its behaviour (cooperative stop, synchronous console.input(), the REPL
// on the main thread). A dev box may enable features.workerRuntime in its
// untracked local.yaml, which would silently route them off-thread and change
// what they are testing. #108's own behaviour is covered by worker-runtime.spec.js.

// Issue #66: an embed with ?outputOnly=true but NO autorun rendered completely
// blank. outputOnly hides the editor, and the non-autorun path hid the output
// pane as well, so nothing was on screen — and the console is created lazily on
// first Run, which never happened.
//
// "Only show output" should mean the output pane IS the embed, even before it
// has anything in it. Deliberately not fixed by forcing a run: the author left
// autorun off on purpose.
test.describe('outputOnly without autorun (#66)', () => {
  async function panes(page) {
    return page.evaluate(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        output: vis('#codeOutput'),
        console: vis('#console-output'),
        editor: vis('#editor')
      };
    });
  }

  test('shows the output pane instead of a blank frame', async ({ page }) => {
    await page.goto('/embed/python3?outputOnly=true&runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.output, 'the output pane must be visible').toBe(true);
      expect(p.console, 'the console itself must be on screen').toBe(true);
    }).toPass({ timeout: 60_000 });
  });

  test('still hides the editor (outputOnly is honoured)', async ({ page }) => {
    await page.goto('/embed/python3?outputOnly=true&runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.editor, 'outputOnly must still hide the editor').toBeFalsy();
    }).toPass({ timeout: 60_000 });
  });

  test('does NOT auto-run — the author left autorun off', async ({ page }) => {
    // The pane appears, but empty: fixing the blank frame must not smuggle in an
    // autorun the embed author didn't ask for.
    await page.goto('/embed/python3?outputOnly=true&runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.console).toBe(true);
    }).toPass({ timeout: 60_000 });

    const text = await page.evaluate(() =>
      document.querySelector('#console-output')?.innerText || '');
    expect(text).not.toContain('hello from the trinket');
  });

  test('REGRESSION: outputOnly WITH autorun still shows output, not the editor', async ({ page }) => {
    // Asserts PANE STATE rather than execution. Two reasons: a bare
    // /embed/python3 has no saved code to autorun (and outputOnly implies
    // noEditor, so none can be typed), and pane state is the only thing this fix
    // could plausibly disturb — the new branch runs ONLY when the autorun branch
    // did not, so the autorun path is untouched.
    //
    // Checked against unmodified main first: an execution-based version of this
    // test failed there identically, i.e. it was a bad test, not a regression.
    await page.goto('/embed/python3?outputOnly=true&start=result&runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.output, 'autorun + outputOnly must still show the output pane').toBe(true);
      expect(p.editor, 'and must still hide the editor').toBeFalsy();
    }).toPass({ timeout: 60_000 });
  });

  test('REGRESSION: an ordinary embed still opens on the editor', async ({ page }) => {
    await page.goto('/embed/python3?runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.editor, 'the normal embed must still show the editor').toBe(true);
    }).toPass({ timeout: 60_000 });
  });

  // Whole-branch review, item 2: this branch added `with context` to the
  // embed templates' import of the Trinket Settings macro so `config` would
  // resolve inside it (lib/views/includes/embed-settings.html's own
  // `{% if not outputOnly %}` guard, previously always-true because
  // `outputOnly` was undefined without context). That correctly stops the
  // modal itself from rendering in output-only embeds -- but left-menu.html's
  // Settings link (data-action="code.settings") was left ungated, so its
  // click handler now opens a #settingsModal that isn't in the DOM. python3
  // is in config.app.configurable, and storageState logs every test in as a
  // real user (playwright.config.js), so `configurable` is true here exactly
  // as it would be for a real output-only embed of a logged-in author's
  // trinket -- this is the live bug shape, not a contrived one.
  test('does not offer a dead Settings menu item (its modal is gone too)', async ({ page }) => {
    await page.goto('/embed/python3?outputOnly=true&runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.output, 'page must have finished rendering').toBe(true);
    }).toPass({ timeout: 60_000 });

    await expect(page.locator('a[data-action="code.settings"]')).toHaveCount(0);
    await expect(page.locator('#settingsModal')).toHaveCount(0);
  });

  test('REGRESSION: an ordinary embed still offers Settings, modal included', async ({ page }) => {
    await page.goto('/embed/python3?runtime=main');

    await expect(async () => {
      const p = await panes(page);
      expect(p.editor, 'the normal embed must still show the editor').toBe(true);
    }).toPass({ timeout: 60_000 });

    await expect(page.locator('a[data-action="code.settings"]')).toHaveCount(1);
    await expect(page.locator('#settingsModal')).toHaveCount(1);
  });
});
