const { test, expect } = require('@playwright/test');

// picup #280: the worker figure's toolbar must actually DO something.
//
// FigureManagerWebAgg ships with `_toolbar2_class = None`. Measured on a deploy
// WITHOUT #280 (v5, 2026-09-11): clicking Zoom or Pan still gets a navigate_mode
// acknowledgment, so the mode toggle was never the broken part. What was dead is
// the ACTION: a rectangle-drag in zoom mode left the view untouched. That is the
// failure Larry's harness could not drive and this spec can: real drags, judged
// by the data coordinates Python reports for fixed pixels (.mpl-message echoes
// "x=… y=…" on motion), which is the view itself rather than a picture of it.
//
// Home is asserted exactly on the y axis and on the x SPAN, not on pixels: the
// worker sets figure.autolayout=True, so tight_layout re-runs on every draw and
// the x mapping drifts a few percent per zoom/Home cycle as the y-tick-label
// width changes the left margin (pan→Home, which keeps label widths, restores
// both axes to the digit). Pre-existing, cosmetic, tracked separately; a
// byte-identical-pixels assertion fails on it and would blame the wrong thing.
//
// Worker deploys only: main-thread figures use matplotlib's own WebAgg page and
// never had this bug.

const PROG = 'import matplotlib.pyplot as plt\nplt.plot([0,1,2,3],[0,1,4,9])\nplt.show()\nprint("FINI")\n';

async function runProgram(page, src) {
  await page.goto('/embed/python3');
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((s) => { document.querySelector('.ace_editor').env.editor.setValue(s, 1); }, src);
  await page.locator('.run-it').first().click();
  await expect.poll(async () => page.evaluate(() =>
    document.querySelector('#console-output')?.innerText || ''), { timeout: 180_000 }).toContain('FINI');
  const fig = page.locator('.worker-figure.mpl-figure').first();
  await fig.waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(2500);                 // first frame + first resize settle
  return fig;
}

// Data coordinates Python reports at a canvas point, via the readout mpl.js
// writes into .mpl-message on motion. Two moves so a motion event fires even
// when the pointer is already there.
function probes(page, fig) {
  return {
    async at(fx, fy) {
      const box = await fig.locator('canvas').last().boundingBox();
      const x = box.x + box.width * fx, y = box.y + box.height * fy;
      await page.mouse.move(x + 2, y + 2); await page.mouse.move(x, y);
      await page.waitForTimeout(500);
      const m = /x=\s*([-−\d.]+)\s+y=\s*([-−\d.]+)/.exec(await fig.locator('.mpl-message').first().textContent());
      if (!m) throw new Error('no coordinate readout: motion events are not reaching Python');
      return { x: parseFloat(m[1].replace('−', '-')), y: parseFloat(m[2].replace('−', '-')) };
    },
    async view() {                                 // x span across 30%..70%, y span across 30%..70%
      const L = await this.at(0.30, 0.50), R = await this.at(0.70, 0.50);
      const T = await this.at(0.50, 0.30), B = await this.at(0.50, 0.70);
      return { xSpan: R.x - L.x, ySpan: T.y - B.y, L, R, T, B };
    },
    async drag(fx0, fy0, fx1, fy1) {
      const box = await fig.locator('canvas').last().boundingBox();
      await page.mouse.move(box.x + box.width * fx0, box.y + box.height * fy0);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(box.x + box.width * (fx0 + (fx1 - fx0) * i / 10),
                              box.y + box.height * (fy0 + (fy1 - fy0) * i / 10));
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForTimeout(2000);
    },
    button: (title) => fig.locator('button.mpl-widget[title^="' + title + '"]'),
  };
}

test.describe('worker figure toolbar (#280)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/embed/python3');
    test.skip(!/workerRuntime\s*:\s*true/.test(await page.content()), 'main-thread deploy: WebAgg toolbar never had this bug');
  });

  test('Zoom: a rectangle-drag narrows the view, Home widens it back', async ({ page }) => {
    const fig = await runProgram(page, PROG); const p = probes(page, fig);
    const initial = await p.view();

    await p.button('Zoom to rectangle').click();
    await expect(fig.locator('.mpl-message').first()).toHaveText(/zoom/i, { timeout: 15_000 });
    await p.drag(0.35, 0.35, 0.65, 0.65);
    const zoomed = await p.view();
    // THE #280 check: without a toolbar on the manager the drag is ignored and
    // both spans stay exactly where they were (RED on v5).
    expect(zoomed.xSpan, 'zoom rectangle should narrow the x view').toBeLessThan(initial.xSpan * 0.7);
    expect(zoomed.ySpan, 'zoom rectangle should narrow the y view').toBeLessThan(initial.ySpan * 0.7);
    await expect(p.button('Back'), 'a zoom pushes a history entry').toHaveAttribute('aria-disabled', 'false');

    await p.button('Reset original view').click();
    await page.waitForTimeout(2500);
    const home = await p.view();
    expect(home.T.y, 'Home restores the y view exactly').toBeCloseTo(initial.T.y, 2);
    expect(home.B.y).toBeCloseTo(initial.B.y, 2);
    expect(Math.abs(home.xSpan - initial.xSpan) / initial.xSpan,
      'Home restores the x span (tolerance is the autolayout drift, see header)').toBeLessThan(0.10);
  });

  test('Pan: a drag shifts the view, Home restores it to the digit', async ({ page }) => {
    const fig = await runProgram(page, PROG); const p = probes(page, fig);
    const initial = await p.view();
    await p.button('Left button pans').click();
    await expect(fig.locator('.mpl-message').first()).toHaveText(/pan/i, { timeout: 15_000 });
    await p.drag(0.50, 0.50, 0.70, 0.50);
    const panned = await p.view();
    expect(panned.L.x, 'pan should shift the x view').not.toBeCloseTo(initial.L.x, 2);
    expect(panned.xSpan, 'pan keeps the span').toBeCloseTo(initial.xSpan, 1);
    await p.button('Reset original view').click();
    await page.waitForTimeout(2500);
    const home = await p.view();
    for (const k of ['L', 'R', 'T', 'B']) {
      expect(home[k].x, `Home restores ${k}.x exactly`).toBeCloseTo(initial[k].x, 2);
      expect(home[k].y, `Home restores ${k}.y exactly`).toBeCloseTo(initial[k].y, 2);
    }
  });
});
