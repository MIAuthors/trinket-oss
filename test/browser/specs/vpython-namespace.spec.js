const { test, expect } = require('@playwright/test');

// THE NAMESPACE RULE (Steve's ruling, 2026-08-10) — a python3 trinket gets NO
// implicit imports, on EITHER runtime.
//
// Recorded in docs/DEPLOY-OVERLAY-GUIDE.md known-gap 7 and the design spec's
// "Namespace rule" section. The worker path always obeyed it (it installs the
// wheel and runs the program, nothing else). The main-thread path did not:
// ensureVpython() used to run `from math import *`, `from random import *` and
// `from vpython import *` before ANY program usesVPython() matched, and
// runVpython() additionally seeded bare `scene` and `rate` globals. That seeding
// came from wmWVPRunner — a WEB VPython runner, where those names ARE the
// environment — and it propped up plain-Python trinkets that merely mention
// vpython. This file is the fix's contract.
//
// Web VPython (`glowscript` trinkets) is NOT in scope here: the RapydScript
// compiler makes `from vpython import *` the default for that type, by
// construction, and it never touches pyodide.js. webvpython.spec.js covers it.
//
// The fixture below is a REAL program of Steve's — the one that surfaced the
// whole thing — in its two forms. Its shape matters: numpy + vpython +
// matplotlib in one program, which nothing in the suite covered before. Both are
// run on BOTH runtimes, because the asymmetry between them WAS the bug.

// A. Correct and portable: every name is either imported or namespaced. Runs
// clean in desktop VPython, in a notebook, and in plain Python too.
const NAMESPACED = [
  'import numpy as np',
  'import vpython as vp',
  'import matplotlib.pyplot as plt',
  'x = np.linspace(0,10,100)',
  's = vp.sphere(color=vp.color.red)',
  'for xval in x:',
  '  s.pos.x = xval',
  '  vp.rate(100)',
  'plt.figure(figsize=(4,2))',
  'plt.plot(x, np.sin(x))',
  'plt.show()',
  'print("PROGRAM_DONE")',
  ''
].join('\n');

// B. The same program with ONE name un-imported: `color.red` instead of
// `vp.color.red`, and no `from vpython import *` anywhere. It is a bug — and it
// must now LOOK like one on both runtimes. Before the fix this ran happily on
// the main thread (the star-import supplied `color`) and raised only in the
// worker; that asymmetry is what is being closed.
const BARE_NAME = NAMESPACED.replace('color=vp.color.red', 'color=color.red');

// C. A student who writes the star-import HERSELF. She must still get the
// cancellation-WRAPPED rate — the whole risk of removing the seeding. See the
// describe block at the bottom for why this is the load-bearing spec.
const STAR_IMPORT_LOOP = [
  'from vpython import *',
  'ball = sphere(color=color.red)',
  'i = 0',
  'while True:',
  '    rate(30)',
  '    ball.pos.x = 0.001 * i',
  '    i += 1',
  '    if i % 15 == 0:',
  '        print("tick")',
  ''
].join('\n');

// --- harness ----------------------------------------------------------------

// The worker path is opt-in and OFF by default, so a dev stack without it would
// fail the worker halves for a configuration reason rather than a code reason.
async function skipUnlessWorkerVPython(page) {
  await page.goto('/embed/python3');
  const on = await page.evaluate(() =>
    !!(window.trinket && window.trinket.config && window.trinket.config.workerVPython));
  test.skip(!on, 'SKIP: features.workerVPython is off in this dev stack. ' +
    'Add `workerVPython: true` under `features:` in config/local.yaml and ' +
    '`docker restart trinket-gcr`, then re-run.');
}

// `?runtime=main` is not decoration: on a stack with workerVPython on — which the
// dev stack has — the router would otherwise send a VPython program off-thread
// and the main-thread half of every pair here would silently test the worker.
async function runOnMain(page, src) {
  await page.goto('/embed/python3?runtime=main');
  await type(page, src);
}

async function runOnWorker(page, src) {
  await skipUnlessWorkerVPython(page);   // its goto is the navigation we then use
  await type(page, src);
}

async function type(page, src) {
  await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate((code) => {
    document.querySelector('.ace_editor').env.editor.setValue(code, 1);
  }, src);
  await page.locator('.run-it').first().click();
}

function output(page) {
  return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
}

// The two paths draw the 3D scene into differently-named containers: the
// main-thread bridge into `#glowscript`, the worker front-end into
// `#vpython-scene`. GLOW IS LAZY — a canvas holding no objects produces no
// <canvas> element at all — so the element appearing is the "the scene is really
// up" signal, not the container.
const SCENE = { main: '#glowscript canvas', worker: '#vpython-scene canvas' };

// The matplotlib figure, by contrast, lands under the SAME selector on both:
// `canvas.mpl-canvas` inside #graphic (the worker additionally wraps it in
// `.worker-figure`). Asserting the shared selector is deliberate — it is the one
// thing about these two paths that a student cannot tell apart.
const FIGURE = '#graphic canvas.mpl-canvas';

// A canvas element with a context is not proof a frame was drawn; pixels are.
// glow does not ask for preserveDrawingBuffer, so the WebGL read has to happen
// INSIDE a frame, and it retries across frames rather than sampling one at an
// arbitrary deadline.
async function countRedInScene(page, selector) {
  return page.evaluate(async (sel) => {
    const cv = document.querySelector(sel);
    if (!cv) return { red: -1, why: 'no canvas' };
    const name = ['webgl2', 'webgl', 'experimental-webgl']
      .find((n) => { try { return !!cv.getContext(n); } catch (e) { return false; } });
    if (!name) return { red: -1, why: 'no WebGL context' };
    const gl = cv.getContext(name);
    const readRed = () => {
      const px = new Uint8Array(4 * cv.width * cv.height);
      gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 60 && px[i + 1] < 60 && px[i + 2] < 60) n++;
      }
      return n;
    };
    let red = -1;
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 120 && red <= 100; i++) { await nextFrame(); red = readRed(); }
    return { red, w: cv.width, h: cv.height };
  }, selector);
}

// The figure canvas is a 2D context, so this one can read straight out of it.
// The plot is dark ink on a white ground: count the pixels that are neither.
async function countInkInFigure(page) {
  return page.evaluate(async (sel) => {
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    let best = { ink: -1, why: 'no canvas' };
    for (let i = 0; i < 120; i++) {
      const cv = document.querySelector(sel);
      if (cv && cv.width && cv.height) {
        const ctx = cv.getContext('2d');
        const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0;
        for (let k = 0; k < px.length; k += 4) {
          if (px[k + 3] > 10 && (px[k] < 200 || px[k + 1] < 200 || px[k + 2] < 200)) ink++;
        }
        best = { ink, w: cv.width, h: cv.height };
        if (ink > 200) return best;
      }
      await nextFrame();
    }
    return best;
  }, FIGURE);
}

// --- A: the correct program, on both runtimes -------------------------------

test.describe('Namespace rule: a correctly-namespaced program runs on both runtimes', () => {
  // numpy + vpython + matplotlib in ONE program. Each of the three has coverage
  // somewhere in this suite; the combination had none, on either path, and it is
  // exactly the combination Steve's program is.
  for (const runtime of ['main', 'worker']) {
    test(`[${runtime}] numpy + vpython + matplotlib: scene AND figure render`, async ({ page }) => {
      test.setTimeout(300_000);          // cold Pyodide boot + the vpython package
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      if (runtime === 'main') await runOnMain(page, NAMESPACED);
      else await runOnWorker(page, NAMESPACED);

      // It really ran where this case says it ran. If this flips, everything
      // below is testing the other path.
      await expect(async () => {
        expect(await page.evaluate(() => window.__trinketRuntime)).toBe(runtime);
      }).toPass({ timeout: 60_000 });

      // The program ran to the end: the rate() loop paced and released, and
      // nothing raised. `vp.rate(100)` is NAMESPACED — the async transform has to
      // recognise it through the `import vpython as vp` alias to insert the
      // await, so this also pins that.
      await expect(async () => {
        expect(await output(page)).toContain('PROGRAM_DONE');
      }).toPass({ timeout: 240_000 });

      const out = await output(page);
      expect(out, 'a correctly-namespaced program must not raise').not.toContain('NameError');
      expect(out).not.toContain('Traceback');

      // 1. The 3D scene rendered...
      await expect(async () => {
        expect(await page.evaluate((sel) =>
          document.querySelectorAll(sel).length, SCENE[runtime])).toBeGreaterThan(0);
      }).toPass({ timeout: 60_000 });
      const scene = await countRedInScene(page, SCENE[runtime]);
      expect(scene.red, 'the red sphere never rasterised: ' + JSON.stringify(scene))
        .toBeGreaterThan(100);

      // 2. ...AND the matplotlib figure did, in the same run. Before this spec
      // nothing anywhere asserted both at once.
      await expect(page.locator(FIGURE).first()).toBeVisible({ timeout: 120_000 });
      const fig = await countInkInFigure(page);
      expect(fig.ink, 'the matplotlib figure never drew: ' + JSON.stringify(fig))
        .toBeGreaterThan(200);

      expect(pageErrors, 'uncaught page exception').toEqual([]);
    });
  }
});

// --- B: the bug, on both runtimes -------------------------------------------

test.describe('Namespace rule: an un-imported name raises on both runtimes', () => {
  // THIS IS THE FIX. Before it, this exact program ran clean on the main thread
  // (`from vpython import *` had already been executed for the student, so
  // `color` resolved) and raised NameError only in the worker. The main thread
  // was propping up a program that fails in desktop VPython, in a notebook and
  // in plain Python. Both paths must now tell the student the same truth.
  for (const runtime of ['main', 'worker']) {
    test(`[${runtime}] bare color.red without an import raises NameError`, async ({ page }) => {
      test.setTimeout(300_000);

      if (runtime === 'main') await runOnMain(page, BARE_NAME);
      else await runOnWorker(page, BARE_NAME);

      await expect(async () => {
        expect(await page.evaluate(() => window.__trinketRuntime)).toBe(runtime);
      }).toPass({ timeout: 60_000 });

      await expect(async () => {
        const out = await output(page);
        expect(out).toContain('NameError');
        // NAMED, not just "some NameError": the message has to point at the
        // name the student failed to import, or it is not a usable diagnosis.
        expect(out).toContain("name 'color' is not defined");
      }).toPass({ timeout: 240_000 });

      // It failed at the sphere() line, i.e. genuinely at the un-imported name,
      // not somewhere incidental later on.
      const out = await output(page);
      expect(out).toContain('line 5');
      expect(out, 'it must not have reached the end').not.toContain('PROGRAM_DONE');
    });
  }
});

// --- C: the regression guard ------------------------------------------------

test.describe('Namespace rule: an explicit star-import still gets the WRAPPED rate', () => {
  // THE IMPORTANT ONE. Removing the seeding removed the bare `rate = ...` global
  // too, so a student's own `from vpython import *` is now the ONLY thing that
  // binds `rate` in her namespace — and a star-import copies whatever the
  // MODULE holds at that moment.
  //
  // Which is why runVpython() still does `_vpy.rate = _wrapped_rate` (and
  // `_vpy.scene = _vpy.canvas(...)`) before the user's code runs. That works
  // because `import vpython as _vpy` binds THE module object in sys.modules —
  // the same object her `from vpython import *` reads from — and both names are
  // in vpython's `__all__`. If it ever stopped working, the visible symptom is
  // precisely this: Stop can no longer kill an animation, because her `rate` is
  // the raw glow one with no cancellation check in it, and the student's only
  // recovery is reloading the page and losing her edits.
  //
  // Main thread only, by design: the worker's Stop is worker.terminate(), which
  // cannot be defeated by a binding. This mechanism exists only here.
  test('[main] Stop kills a rate() loop written with `from vpython import *`',
    async ({ page }) => {
      test.setTimeout(300_000);

      await runOnMain(page, STAR_IMPORT_LOOP);
      await expect(async () => {
        expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
      }).toPass({ timeout: 60_000 });

      // It is genuinely animating before we interrupt it — otherwise a program
      // that died at line 1 would "stop" just fine.
      await expect(async () => {
        expect(await output(page)).toContain('tick');
      }).toPass({ timeout: 240_000 });

      const stop = page.locator('.stop-it');
      await expect(stop).toBeVisible({ timeout: 90_000 });
      await page.waitForTimeout(500);       // the toolbar re-lays out as Stop appears
      await stop.click();

      // The loop unwound at its next rate() and the run ended.
      await expect(stop).toBeHidden({ timeout: 30_000 });

      const out = await output(page);
      expect(out).toContain('stopping');
      // The give-up message pyodide.js prints 3 s after a Stop that did NOT take.
      // Its presence is the exact failure signature of an unwrapped rate.
      expect(out, 'the rate() loop ignored cancellation — `rate` is not the wrapped one')
        .not.toContain('no pause point');

      // ...and it really is dead, not merely un-badged.
      const before = (await output(page)).length;
      await page.waitForTimeout(3000);
      expect((await output(page)).length,
        'output kept growing after Stop: the loop is still running').toBe(before);
    });
});
