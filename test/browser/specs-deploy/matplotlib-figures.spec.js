const { test, expect } = require('@playwright/test');

// picup #272 (closes #254): plt.show() is idempotent PER FIGURE.
//
// This exists because nothing else covers matplotlib on a deploy. #272 is the
// only change in its batch not behind a feature flag, so it is the one that
// reaches students the moment it merges — and the unit test for it exercises
// the setup code, not a browser. The defects it fixes are all *counting*
// defects (a figure drawn twice, a figure never drawn, six containers for one
// figure), which only a real run can see.
//
// Figure counting: matplotlib's WebAgg backend emits TWO canvases per figure
// (the figure plus a rubber-band overlay), and the worker path wraps each in
// .mpl-figure instead. Count containers, not canvases, and handle both.

async function runProgram(page, src) {
  await page.goto('/embed/python3');
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((s) => {
    document.querySelector('.ace_editor').env.editor.setValue(s, 1);
  }, src);
  await page.locator('.run-it').first().click();
  // Poll the CONSOLE, never document.body: the body contains the source, so a
  // sentinel printed by the program is already "present" before it ever runs.
  await expect
    .poll(async () => page.evaluate(() =>
      document.querySelector('#console-output')?.innerText || ''), { timeout: 180_000 })
    .toContain('FINI');
}

const figureCount = (page) => page.evaluate(() => {
  const con = document.querySelector('#console-output');
  const wrapped = document.querySelectorAll('.mpl-figure');
  if (wrapped.length) return wrapped.length;
  const hosts = new Set();
  document.querySelectorAll('canvas').forEach((c) => {
    if (con && con.contains(c)) return;      // console canvases are not figures
    hosts.add(c.closest('div'));
  });
  return hosts.size;
});

const CASES = [
  ['show() twice on one figure draws it once', 1,
   'import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()\nplt.show()\nprint("FINI")\n'],
  ['a figure created after show() still appears', 2,
   'import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()\nplt.figure()\nplt.plot([3,2,1])\nplt.show()\nprint("FINI")\n'],
  ['show() in a loop draws one figure per pass', 3,
   'import matplotlib.pyplot as plt\nfor i in range(3):\n    plt.figure()\n    plt.plot([i,i+1,i+2])\n    plt.show()\nprint("FINI")\n'],
  // Not a typo: a figure left open without show() is auto-displayed on purpose,
  // so a student who forgets show() still sees their plot. Asserted so that
  // behaviour cannot be dropped by a future change to show() accounting.
  ['a figure with no show() at all is auto-displayed', 1,
   'import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nprint("FINI")\n'],
];

test.describe('matplotlib figures are drawn exactly once each', () => {
  for (const [title, expected, src] of CASES) {
    test(title, async ({ page }) => {
      const crashes = [];
      page.on('pageerror', (e) => crashes.push(e.message));
      await runProgram(page, src);
      await expect.poll(() => figureCount(page), { timeout: 30_000 }).toBe(expected);
      expect(crashes, 'a plotting program must not throw').toEqual([]);
    });
  }
});
