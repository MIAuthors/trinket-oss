const { test, expect } = require('@playwright/test');

// The dpi pane fit: the figure is fitted to the output pane by scaling
// figure.dpi with figsize FIXED, so the picture is the same composition at a
// different scale and the download never depends on the browser window.
//
// These read window.__trinketPaneFit, the probe pyodide.js exposes for them.
// That matters: the failures this guards against look FINE in a screenshot.
// figsize drifting a few hundredths of an inch per fit, or a classifier calling
// a student's drag an echo, are invisible until someone downloads a file or
// resizes twice -- so the assertions are on the classifier's own decisions and
// on Python's numbers, not on pixels alone.
//
// Both runtimes, because they diverge: the worker's round trip is asynchronous
// and its toolbar carries Font Awesome glyphs, while the main thread's is
// synchronous with matplotlib's own PNG icons. Every bug below appeared on one
// and not the other.
//
// dpr is whatever the browser gives. Playwright's emulated deviceScaleFactor
// does NOT drive devicePixelContentBoxSize, so a dpr-2 run means a HEADED
// Chrome on a retina panel -- the assertions here are written to hold at any
// density rather than to pin one.

const PROG = [
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  't = np.linspace(0, 10, 300)',
  'plt.plot(t, np.exp(-0.35*t)*np.cos(4*t))',
  "plt.xlabel('time (s)'); plt.ylabel('displacement (m)'); plt.title('Damped')",
  'plt.show()',
  'print("FINI")',
].join('\n');

const RUNTIMES = [['worker', '?runtime=worker'], ['main', '?runtime=main']];

async function runFigure(page, query, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/embed/python3' + query);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((s) => {
    document.querySelector('.ace_editor').env.editor.setValue(s, 1);
  }, PROG);
  await page.locator('.run-it').first().click();
  await expect.poll(async () => page.evaluate(() =>
    document.querySelector('#console-output')?.innerText || ''),
    { timeout: 240_000 }).toContain('FINI');
  // The canvas mpl.js creates, not #graphic -- that is in the page's own HTML
  // and is attached before the program has even run.
  await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(4000);           // the fit's round trip, then settle
}

function readProbe(page) {
  return page.evaluate(() => {
    const st = window.__trinketPaneFit.state();
    const one = st[Object.keys(st)[0]];
    const tb = document.querySelector('#graphic .mpl-toolbar');
    const sel = tb && tb.querySelector('select.mpl-widget');
    const btn = tb && tb.querySelector('button.mpl-widget');
    const c = document.querySelector('#graphic canvas');
    const div = c.parentNode;
    return {
      probe: one,
      classified: window.__trinketPaneFit.classified.map(e => `${e.kind}:${e.w}x${e.h}`),
      canvas: { w: c.clientWidth, h: c.clientHeight },
      div: { w: parseFloat(div.style.width) || c.clientWidth },
      toolbar: {
        height: tb && tb.offsetHeight,
        selectWidth: sel && sel.offsetWidth,
        selectHeight: sel && sel.offsetHeight,
        selectRadius: sel && getComputedStyle(sel).borderRadius,
        buttonHeight: btn && btn.offsetHeight,
        topsAlign: btn && sel
          ? Math.abs(btn.getBoundingClientRect().top - sel.getBoundingClientRect().top) <= 1
          : null,
      },
      overrideInjected: !!document.getElementById('trinket-mpl-toolbar-css'),
      dpr: window.devicePixelRatio,
    };
  });
}

test.describe('pane fit: startup', () => {
  for (const [label, query] of RUNTIMES) {
    test(`${label}: the first fit lands once and agrees with the canvas`, async ({ page }) => {
      await runFigure(page, query, { width: 1280, height: 900 });
      const got = await readProbe(page);
      const kinds = got.classified.map(s => s.split(':')[0]);

      // mpl.js's own startup resize is classified as such, once, and the first
      // fit is issued FROM it -- which is after socket.onopen has carried the
      // device pixel ratio to Python. Issuing it at registration instead made
      // manager.resize divide by a ratio still at 1, sizing the div in DEVICE
      // pixels: at dpr 2 that recomputed figsize as 9.82x7.37in and overflowed
      // every pane. It did not show at every window size, nor on main, whose
      // synchronous round trip coalesces the two resizes.
      expect(kinds.filter(k => k === 'startup'), `one startup: ${got.classified}`).toHaveLength(1);

      // Nobody dragged anything, so nothing may be classified as a drag. A drag
      // is what recomputes figsize, and a misclassified one is the ratchet.
      expect(kinds.filter(k => k === 'drag'), `no drags: ${got.classified}`).toHaveLength(0);

      // The div sized in device pixels was the doubling bug's signature.
      expect(Math.abs(got.div.w - got.canvas.w),
        `div ${got.div.w} vs canvas ${got.canvas.w} at dpr ${got.dpr}`).toBeLessThanOrEqual(1);

      // And it still fits. The bug overflowed by 227x171.
      expect(got.canvas.w, 'figure fits the pane').toBeLessThanOrEqual(got.probe.box.w + 1);

      // Bounded, NOT drained: an echo is not guaranteed. If the size Python
      // asks for is the size the div already has, the browser delivers no
      // ResizeObserver callback and nothing decrements the count.
      expect(got.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
      expect(got.probe.awaitStartup, 'the startup resize was consumed').toBe(false);

      // Redundant fits are dropped at source rather than counted, so the bound
      // holds however many arrive.
      const after = await page.evaluate(async () => {
        for (let i = 0; i < 10; i++) window.__trinketPaneFit.fit();
        await new Promise(r => setTimeout(r, 1500));
        const st = window.__trinketPaneFit.state();
        return st[Object.keys(st)[0]].pendingFits;
      });
      expect(after, 'redundant fits are skipped, not counted').toBeLessThanOrEqual(2);
    });
  }
});

test.describe('pane fit: the figure gets the whole pane', () => {
  for (const [label, query] of RUNTIMES) {
    test(`${label}: toolbar is one row and the dropdown matches the buttons`, async ({ page }) => {
      // A tall window, where HEIGHT binds -- which it does in most desktop
      // sizes, because the graphic pane's height follows the window at a 65%
      // split. That is what makes the toolbar's height worth reclaiming.
      await runFigure(page, query, { width: 1920, height: 1080 });
      const got = await readProbe(page);
      const tb = got.toolbar;

      // Foundation styles bare `select { width: 100% }`, which stretched
      // mpl.js's format dropdown across the whole toolbar so it could not share
      // a line with the buttons at any pane size: 109px of toolbar where
      // matplotlib intends about 55, costing every figure 54px of height.
      expect(got.overrideInjected, 'the Foundation override is injected').toBe(true);
      expect(tb.selectWidth, 'the dropdown is its natural width, not 100%')
        .toBeLessThan(got.probe.box.w / 2);

      // Height, not row count: distinct offsetTop values do NOT mean distinct
      // lines for inline-block children of different heights -- they sit on one
      // line at different baselines, which is the passing state.
      expect(tb.height, 'toolbar is one row tall').toBeLessThanOrEqual(70);
      expect(got.probe.chrome, 'chrome is the title bar plus one toolbar row').toBeLessThan(100);

      // Sitting beside the buttons, it has to look like one. Read off a real
      // button rather than written down: the worker's are 34px (Font Awesome)
      // and the main thread's 38px (matplotlib's PNGs), so no constant fits both.
      expect(tb.selectHeight, 'dropdown is button height').toBe(tb.buttonHeight);
      expect(tb.selectRadius, 'dropdown is not boxy').not.toBe('0px');
      expect(tb.topsAlign, 'dropdown and buttons share a baseline').toBe(true);

      // The point of all of it: one fit, and the figure uses the pane.
      expect(got.classified.filter(k => k.startsWith('echo')),
        `startup settles in one fit: ${got.classified}`).toHaveLength(1);
      expect(got.canvas.w, 'figure fills the available width')
        .toBeGreaterThan(got.probe.box.w * 0.9);
    });
  }
});

// A student's second Run of the same program. Everything above runs the program
// ONCE per page, which is what let this through: figure ids are reused (Pyodide
// numbers the main thread's figures from 1 every run, the worker calls its
// figure 'fig1'), so registration used to find the previous run's state and
// return, leaving every fit addressed to a detached figure on a dead socket.
//
// Measured on the main thread at dpr 2 before the fix: run twice, narrow the
// window, and the figure stayed 480px inside a 398px pane with NOTHING in the
// classifier log; a corner drag on the new figure was then classified as an
// echo, because the pointerdown listener sat on a div no longer in the
// document. The worker was unaffected -- it tore its state down per run -- so
// this needs both runtimes to be worth anything.
test.describe('pane fit: the second run', () => {
  for (const [label, query] of RUNTIMES) {
    test(`${label}: a re-run's figure is the one that gets fitted`, async ({ page }) => {
      await runFigure(page, query, { width: 1600, height: 900 });
      const first = await readProbe(page);

      // Mark the first run's canvas, then wait for a canvas that is not it.
      // NOT the console: it is cleared at the start of every run, so the
      // completion marker cannot appear twice -- and not the classifier log
      // either, because under the bug nothing is ever logged, which would fail
      // this as a timeout instead of as the assertion that names the symptom.
      await page.evaluate(() => {
        document.querySelector('#graphic canvas').dataset.trinketPrevRun = '1';
      });
      await page.locator('.run-it').first().click();
      await expect.poll(async () => page.evaluate(() => {
        const c = document.querySelector('#graphic canvas');
        return !!c && c.dataset.trinketPrevRun !== '1';
      }), { timeout: 240_000 }).toBe(true);
      await page.waitForTimeout(4000);

      // The mechanism: the new figure registered, rather than inheriting the
      // old figure's state and returning at the guard.
      const second = await readProbe(page);
      expect(second.classified.filter(s => s.startsWith('startup')).length,
        `a startup per run: ${second.classified}`).toBeGreaterThan(
        first.classified.filter(s => s.startsWith('startup')).length);

      // The symptom, which is what a student sees: narrow the window and the
      // figure follows. 1200 keeps the side-by-side layout (below about 1100
      // the output pane becomes tabbed, which is a different test).
      await page.setViewportSize({ width: 1200, height: 900 });
      await expect.poll(async () => {
        const got = await readProbe(page);
        return got.canvas.w <= got.probe.box.w + 1;
      }, { timeout: 30_000, message: 'the re-run figure never fitted the narrowed pane' }).toBe(true);

      const after = await readProbe(page);
      expect(after.canvas.w, `figure ${after.canvas.w} in a ${after.probe.box.w} pane`)
        .toBeLessThanOrEqual(after.probe.box.w + 1);
      expect(after.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
    });
  }
});
