const { test, expect } = require('@playwright/test');

// §16 canary (decision V3): the captured transport stream, the PORTED handler,
// and trinket's SERVED glow 3.2.3 — before anything is built on that combination.
// No worker involved: the fixtures are replayed directly on a blank embed page.

// Captured verbatim from the channel spike. MSG0's second entry has NO `cmd`
// key — it exercises handle_cmds' non-constructor path; do not "fix" it.
const MSG0 = {"cmds": [{"cmd": "canvas", "idx": 0}, {"lights": "empty_list", "idx": 0}, {"cmd": "distant_light", "idx": 2, "direction": [0.22, 0.44, 0.88], "color": [0.8, 0.8, 0.8], "canvas": 0}, {"cmd": "distant_light", "idx": 3, "direction": [-0.88, -0.22, -0.44], "color": [0.3, 0.3, 0.3], "canvas": 0}]};
const MSG1 = {"cmds": [{"cmd": "sphere", "idx": 4, "color": [1.0, 0.0, 0.0], "size": [3.0, 3.0, 3.0], "canvas": 0}], "attrs": ["a4a1,2,3"]};

test.describe('Worker VPython (vpython-jupyter adoption)', () => {
  test('CANARY: captured sphere stream renders on trinket glow 3.2.3', async ({ page }) => {
    const logs = [];
    page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
    // Kept separate from `logs` because it is ASSERTED, not just printed: an
    // exception thrown inside glow's async render loop lands here and nowhere
    // else, and would otherwise be invisible unless it happened to zero the
    // pixel count. Tasks 8-11 add genuinely async behaviour to this file.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/embed/python3?runtime=main');   // any embed page; we just need a DOM + origin

    const result = await page.evaluate(async ([MSG0, MSG1]) => {
      const load = (src) => new Promise((ok, bad) => {
        const s = document.createElement('script'); s.src = src; s.onload = ok;
        s.onerror = () => bad(new Error('failed to load ' + src));
        document.head.appendChild(s);
      });
      await load('/components/vpython-glowscript/package/glow.3.2.3.min.js');
      await load('/components/vpython-worker/glowcomm_host.js');

      const holder = document.createElement('div');
      holder.id = 'canary-scene'; document.body.appendChild(holder);
      // glowcomm.js:776-778 sets __context before the constructors run; the port
      // merges into it as well, but it has to exist first.
      window.__context = { glowscript_container: $(holder) };

      const errs = [];
      const fe = self.createGlowFrontend({ container: holder, send: () => {} });
      try { fe.handle(JSON.parse(JSON.stringify(MSG0))); }
      catch (e) { errs.push('MSG0: ' + ((e && e.stack) || e)); }
      try { fe.handle(JSON.parse(JSON.stringify(MSG1))); }
      catch (e) { errs.push('MSG1: ' + ((e && e.stack) || e)); }

      // The registry, against the REAL glow constructors (the unit suite can only
      // check this against a stub): idx 0 canvas, 2+3 lights, 4 sphere, and the
      // compact attr code "a4a1,2,3" applied to the live sphere as a glow vector.
      const objs = fe._objs();
      const sphere = objs[4];
      const shape = {
        idxs: Object.keys(objs),
        isCanvas: !!(objs[0] && objs[0].__proto__ && objs[0].__proto__.constructor === window.canvas),
        lights: (objs[0] && objs[0].lights && objs[0].lights.length) || 0,
        pos: sphere && sphere.pos ? [sphere.pos.x, sphere.pos.y, sphere.pos.z] : null,
        color: sphere && sphere.color ? [sphere.color.x, sphere.color.y, sphere.color.z] : null,
      };

      // GlowScript renders into a <canvas> inside the container.
      await new Promise(r => setTimeout(r, 1500));
      const cv = holder.querySelector('canvas');
      if (!cv) return { ok: false, why: 'no canvas element', errs, shape };

      const glName = ['webgl2', 'webgl', 'experimental-webgl']
        .find(n => { try { return !!cv.getContext(n); } catch (e) { return false; } });
      const gl = glName ? cv.getContext(glName) : null;
      if (!gl) return { ok: false, why: 'no WebGL context', errs, shape };

      // Count red-ish pixels: the fixture sphere is color=[1,0,0] on a black scene.
      const readRed = () => {
        const px = new Uint8Array(4 * cv.width * cv.height);
        gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) { if (px[i] > 60 && px[i+1] < 60 && px[i+2] < 60) n++; }
        return n;
      };
      // glow does not ask for preserveDrawingBuffer, so a read taken outside the
      // drawing frame sees a cleared buffer (measured: 0). The shipped assertion
      // reads inside a rAF callback; `direct` is kept only to document that.
      let direct = -1, inFrame = -1, readErr = null;
      try { direct = readRed(); } catch (e) { readErr = String(e); }
      try {
        inFrame = await new Promise((res, rej) => {
          requestAnimationFrame(() => { try { res(readRed()); } catch (e) { rej(e); } });
        });
      } catch (e) { readErr = String(e); }

      return {
        errs, shape, glName, readErr, direct, inFrame,
        preserveDrawingBuffer: !!gl.getContextAttributes().preserveDrawingBuffer,
        w: cv.width, h: cv.height,
        why: 'red px: inFrame=' + inFrame + ' (direct=' + direct + ')',
      };
    }, [MSG0, MSG1]);

    console.log('CANARY diagnostics: ' + JSON.stringify(result, null, 2));
    if (logs.length) console.log('page console:\n' + logs.join('\n'));

    expect(result.errs, 'the ported handler threw on the captured stream').toEqual([]);
    // Nothing blew up asynchronously either — see the pageErrors comment above.
    // No filter: the only page-console noise these runs produce is SwiftShader's
    // "GPU stall due to ReadPixels" performance warning, which is a console
    // warning and never reaches pageerror.
    expect(pageErrors, 'uncaught page exception (glow render loop?)').toEqual([]);
    // Whole stream landed on real glow constructors.
    expect(result.shape.idxs).toEqual(['0', '2', '3', '4']);
    expect(result.shape.isCanvas).toBe(true);       // idx 0 is a real glow canvas, not just some object
    expect(result.shape.lights).toBe(2);            // "empty_list" cleared the defaults, 2 distant_lights added
    expect(result.shape.pos).toEqual([1, 2, 3]);    // compact attr code "a4a1,2,3" reached the live object
    expect(result.shape.color).toEqual([1, 0, 0]);
    // ...and it actually rasterised: a red sphere occupies >100 pixels.
    expect(result.inFrame).toBeGreaterThan(100);
  });

  // --- Task 7: the real path ------------------------------------------------
  // Everything above replays fixtures. Everything below runs a STUDENT PROGRAM:
  // editor -> router -> worker -> vpython wheel -> transport -> scene-ops ->
  // the page host shim -> GlowScript on the page.
  //
  // NOTE (Task 8 owns the fix): needsTransform() in pyodide-worker.js still
  // gates the async transform on `input(`, so `rate()` in a worker run returns
  // a coroutine nobody awaits. Every program here is therefore deliberately
  // STATIC — no rate(), no animation. Animation is Task 8's spec.

  const STATIC_SPHERE = 'from vpython import *\nball = sphere(color=color.red)\n';

  // The path is opt-in and OFF by default, so a dev stack without it in
  // config/local.yaml would fail these for a configuration reason rather than a
  // code reason. Probe the flag the page actually received and say what to do.
  async function skipUnlessWorkerVPython(page) {
    await page.goto('/embed/python3');
    const on = await page.evaluate(() =>
      !!(window.trinket && window.trinket.config && window.trinket.config.workerVPython));
    test.skip(!on, 'SKIP: features.workerVPython is off in this dev stack. ' +
      'Add `workerVPython: true` under `features:` in config/local.yaml and ' +
      '`docker restart trinket-gcr`, then re-run.');
  }

  async function runProgram(page, src) {
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((code) => {
      document.querySelector('.ace_editor').env.editor.setValue(code, 1);
    }, src);
    await page.locator('.run-it').first().click();
  }

  test('a real program renders a sphere via the worker', async ({ page }) => {
    // Well past the file's 90 s default: a cold Pyodide boot plus a 3.5 MB wheel
    // install is the slow part, and the toPass budget below has to fit inside it.
    test.setTimeout(300_000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await skipUnlessWorkerVPython(page);
    await runProgram(page, STATIC_SPHERE);

    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
      // GLOW IS LAZY (Task 2 finding): a canvas with no objects produces no
      // <canvas> element at all, so the element itself — not the container — is
      // the "the scene is really up" signal.
      const n = await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length);
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // ...and it is THIS program's sphere, not just any canvas: the student's
    // `color=color.red` survived Python -> wire -> port -> glow as a real vector.
    const scene = await page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs();
      const red = objs.find((o) => o && o.color && o.color.x === 1 && o.color.y === 0 && o.color.z === 0);
      return { count: objs.filter(Boolean).length, red: !!red };
    });
    expect(scene.red, 'the red sphere never reached GlowScript').toBe(true);
    expect(scene.count).toBeGreaterThan(1);   // canvas + lights + the sphere

    // The scene shares the output pane with the console, exactly like a figure.
    await expect(page.locator('#graphic-wrap')).toBeVisible();
    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  test('scene ops carry the live generation, and a stale scene is dropped', async ({ page }) => {
    test.setTimeout(300_000);   // two full runs, plus a quiet-stream measurement
    // Task 5 stamps `generation` on every scene-ops package and Task 7 owns the
    // counter it stamps; until now neither had a test. Tap the worker channel
    // from OUTSIDE the page code so the assertion sees the real wire messages.
    await page.addInitScript(() => {
      const RealWorker = window.Worker;
      window.__sceneOps = [];
      window.__workers = [];
      window.Worker = function (url, options) {
        const w = new RealWorker(url, options);
        window.__workers.push(w);
        w.addEventListener('message', (e) => {
          const d = e && e.data;
          if (d && d.type === 'scene-ops') window.__sceneOps.push(d.generation);
        });
        return w;
      };
      window.Worker.prototype = RealWorker.prototype;
    });

    await skipUnlessWorkerVPython(page);
    await runProgram(page, STATIC_SPHERE);

    await expect(async () => {
      const n = await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length);
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // The pacing clock belongs to the RUN, not to the scene. Once the program has
    // finished (plus a short drain so its last objects flush), the stream must go
    // quiet: an idle scene polling the worker 30 times a second for the life of
    // the tab is pure cost, and glow orbits the camera on this thread anyway.
    await expect(async () => {
      const before = await page.evaluate(() => window.__sceneOps.length);
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => window.__sceneOps.length),
        'the pacing clock is still ticking after the run finished').toBe(before);
    }).toPass({ timeout: 60_000 });

    // Every package of the first run carries generation 1 — the page's counter,
    // bumped once when this run tore the previous (empty) scene down. A literal
    // 0 would mean the kernel is still being told a constant.
    const gens = await page.evaluate(() => window.__sceneOps.slice());
    expect(gens.length).toBeGreaterThan(0);
    expect([...new Set(gens)]).toEqual([1]);
    expect(await page.evaluate(() => window.__vpythonScene.generation)).toBe(1);
    expect(await page.evaluate(() => window.__vpythonScene.handled)).toBeGreaterThan(0);

    // A package from a scene the page has already torn down must be dropped, not
    // drawn. Inject one directly on the worker object: `generation` is the only
    // thing that makes it stale, and this is the cheapest way to produce one
    // deterministically.
    // The counters are read inside the SAME evaluate as the dispatch: the pacer
    // is live and moves `handled` between two separate round trips.
    const probe = await page.evaluate(() => {
      const before = window.__vpythonScene.dropped;
      window.__workers[0].dispatchEvent(new MessageEvent('message', { data: {
        type: 'scene-ops', id: 'stale-run', generation: 999,
        ops: JSON.stringify({ cmds: [{ cmd: 'box', idx: 77, canvas: 0 }] }),
      }}));
      return { before, after: window.__vpythonScene.dropped };
    });
    expect(probe.after).toBe(probe.before + 1);
    // ...and it never reached the front-end: idx 77 was never constructed.
    expect(await page.evaluate(() =>
      window.__vpythonScene.frontend._objs()[77] === undefined)).toBe(true);

    // Re-run: the scene is thrown away and the next generation is what the
    // kernel stamps from then on (the worker's Python namespace survives, which
    // is exactly why the tag has to move).
    await page.evaluate(() => { window.__sceneOps.length = 0; });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      const after = await page.evaluate(() =>
        window.__sceneOps.filter((g) => g !== 999));
      expect(after.length).toBeGreaterThan(0);
      expect(Math.max(...after)).toBe(2);
    }).toPass({ timeout: 120_000 });
    expect(await page.evaluate(() => window.__vpythonScene.generation)).toBe(2);
  });
});
