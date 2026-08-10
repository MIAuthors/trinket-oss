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
});
