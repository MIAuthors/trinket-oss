# Worker VPython via vpython-jupyter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Dispatch implementers and reviewers on model `opus`** (Steve's request — this feature touches the most load-bearing code in the product).

**Goal:** Opt-in path where Web VPython programs run through the `vpython-jupyter` package in the #108 Web Worker, rendered by GlowScript on the page — VPython animations become killable by Stop, page never freezes.

**Architecture:** Python half (vpython + `trinket_worker` transport) already works in the worker; this plan builds the browser half — a host-agnostic front-end ported from `glowcomm.js` living in vpython-jupyter — plus trinket's routing, wheel delivery, and page shim. Wire format: `{cmds, methods, attrs}` packages out on `scene-ops`, glowcomm-format events back on `scene-event`.

**Tech Stack:** Pyodide 3.13 worker (exists), vpython-jupyter `pyodide-packaging` branch (exists), GlowScript glow 3.2.3 (trinket's served bundle), vitest (node unit), Playwright (browser).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-vpython-jupyter-adoption-design.md`. Decisions V1–V7 are settled; do not relitigate.
- **Two repos.** trinket work happens in `~/Development/glow-repos/merge-test` on branch `spike/vpython-jupyter-pyodide`. vpython-jupyter work happens in `~/Development/glow-repos/vpython-jupyter` on branch `pyodide-packaging`. Never push either; never touch `master`/`main`.
- **The main-thread bridge is untouched.** No task edits `public/js/embed/wvpython/` or main-thread execution paths, except the one-line `GLOW_SRC` pin (Task 3).
- **Flag:** `features.workerVPython`, default `false`. `?runtime=worker` must NOT enable this path; `?runtime=main` always escapes it.
- **Front-end factory API (exact):** `createGlowFrontend({container, send, glow})` → `{handle(opsObject), reset(), destroy()}`. No Jupyter globals, no websockets, no trinket references inside the factory file.
- **Loud deferrals:** `pause`/`waitfor`/widgets raise `NotImplementedError` with the message text in Task 6 — never silent no-ops.
- **Python state persists across runs; the scene does not** (generation counter, Task 5/7).
- **Unit tests (trinket):** run in the amd64 container: `docker run --rm --platform linux/amd64 -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app node:20-bullseye npx vitest run <file>` — **`node:20-bullseye`, never `node:20`** (mongod binary fetch fails on Debian 12). If `config/local.yaml` exists in the worktree, it must be masked during unit runs (it isn't, in merge-test — check first).
- **Browser tests:** `cd test/browser && ./node_modules/.bin/playwright test specs/<file> -g "<pattern>"` against the dev stack on `http://localhost:3001` (container `trinket-gcr` bind-mounts `gcr-firestore-base`, NOT merge-test — see "Serving" below). Never `run-smoke.sh` (it downs the compose stack on exit).
- **Serving during development:** the dev container serves `gcr-firestore-base`. To browser-test merge-test changes: `for f in pyodide.js pyodide-worker.js worker-client.js; do cp public/js/embed/$f ~/Development/glow-repos/gcr-firestore-base/public/js/embed/$f; done` plus any new served files (front-end JS, wheel). This is already the state of that worktree (spike files are copied there); keep it in sync after each page/kernel change. Restore at the very end only if Steve asks.
- **Commit messages** end with the Co-Authored-By + Claude-Session trailer used throughout this branch (`git log -1 --format=%B` for the pattern).

## File Map

**vpython-jupyter (`pyodide-packaging`):**
| File | Responsibility |
|---|---|
| `vpython/vpython_libraries/glowcomm_host.js` (new) | Host-agnostic front-end factory: wire-format decode + handle_cmds/methods/attrs + event capture/pacing. Ported from `glowcomm.js`. |
| `vpython/trinket_worker.py` (grows) | Transport (exists) + async `rate`/`sleep` patches + loud stubs. |
| `vpython/__init__.py` (2 lines) | Eager transport boot under emscripten, before name bindings. |
| `tests/test_trinket_worker.py` (new) | CPython tests for patches/stubs with fake `js`/`pyodide` modules. |

**trinket (`spike/vpython-jupyter-pyodide` in merge-test):**
| File | Responsibility |
|---|---|
| `public/components/vpython-worker/` (new) | Served copies: `glowcomm_host.js` + the pure wheel. Synced by `scripts/sync-vpython-worker.sh` (new). |
| `public/js/embed/runtime-router.js` | One new rule: vpython + flag → worker. |
| `config/default.yaml` | `workerVPython: false` + comment. |
| `public/js/embed/pyodide-worker.js` | Wheel install for vpython runs; generation tag on scene-ops. |
| `public/js/embed/worker-client.js` | Pass `vpython`/`sceneGeneration` through on run. |
| `public/js/embed/pyodide.js` | `GLOW_SRC` pin 3.2.3; host shim replacing the spike's `handleWorkerSceneOps`; generation lifecycle. |
| `test/unit/glowcomm-host.test.js` (new) | Factory against a stub glow, fed captured spike fixtures. |
| `test/unit/runtime-router.test.js` | New-rule cases. |
| `test/browser/specs/worker-vpython.spec.js` (new) | Canary, render, animate+Stop, click, gcurve, re-run, deferral message. |
| `docs/DEPLOY-OVERLAY-GUIDE.md` | `workerVPython` section. |

**Captured wire fixtures** (from the channel spike, verbatim — used by Tasks 1, 2):

```js
// MSG0: transport boot flush — canvas + lights. NOTE the second entry has NO
// `cmd` key ({"lights":"empty_list","idx":0}) — it exercises handle_cmds'
// non-constructor path; do not "fix" the fixture.
var MSG0 = {"cmds": [{"cmd": "canvas", "idx": 0}, {"lights": "empty_list", "idx": 0}, {"cmd": "distant_light", "idx": 2, "direction": [0.22, 0.44, 0.88], "color": [0.8, 0.8, 0.8], "canvas": 0}, {"cmd": "distant_light", "idx": 3, "direction": [-0.88, -0.22, -0.44], "color": [0.3, 0.3, 0.3], "canvas": 0}]};
// MSG1: sphere constructor + ball.pos=vector(1,2,3) as a compact attr code.
var MSG1 = {"cmds": [{"cmd": "sphere", "idx": 4, "color": [1.0, 0.0, 0.0], "size": [3.0, 3.0, 3.0], "canvas": 0}], "attrs": ["a4a1,2,3"]};
```

---

### Task 1: Port the front-end core (decode + handle_cmds + handle_attrs) into `createGlowFrontend`, unit-tested against a stub glow

**Files:**
- Create: `~/Development/glow-repos/vpython-jupyter/vpython/vpython_libraries/glowcomm_host.js`
- Create: `scripts/sync-vpython-worker.sh` (trinket)
- Create: `public/components/vpython-worker/glowcomm_host.js` (synced copy, trinket)
- Test: `test/unit/glowcomm-host.test.js` (trinket)

**Interfaces:**
- Consumes: `vpython/vpython_libraries/glowcomm.js` as the port source — specifically `o2vec3` (:576), `fix_location` (:552), `decode` (:473), `handler` (:581), `handle_cmds` (:597), `handle_attrs` (:948). Leave `handle_methods` (:879) for Task 8-adjacent work ONLY if a test needs it; port it now if the port is easier kept whole (it is — port it, it's used by curve/points updates).
- Produces: `createGlowFrontend({container, send, glow})` → `{handle(ops), reset(), destroy()}` where `glow` is the constructor registry (defaults to `globalThis`), `ops` is the parsed `{cmds, methods, attrs}` object (or the string `"trigger"`, which is a no-op for `handle`). UMD export exactly like `runtime-router.js` (`module.exports` + `TrinketIO.export('embed.glowFrontend', api)` is NOT used here — this file must stay trinket-free: `module.exports` + `self.createGlowFrontend = factory` global).

- [ ] **Step 1: Write the failing unit test** (trinket `test/unit/glowcomm-host.test.js`):

```js
'use strict';
// The vpython-jupyter front-end factory, fed the EXACT packages the transport
// emitted in the channel spike. The glow registry is a stub that records
// constructor calls — rendering correctness is Task 2's browser canary.
const { createGlowFrontend } = require('../../public/components/vpython-worker/glowcomm_host.js');

const MSG0 = /* fixture above, verbatim */;
const MSG1 = /* fixture above, verbatim */;

function stubGlow() {
  const calls = [];
  const mk = (name) => (cfg) => { calls.push({ name, cfg }); return { __stub: name, pos: null }; };
  const names = ['canvas','sphere','box','arrow','cone','cylinder','helix','pyramid','ring',
                 'curve','points','vertex','distant_light','local_light','label','gcurve','gdots',
                 'vec','vector','attach_arrow','attach_trail'];
  const g = {}; names.forEach(n => g[n] = mk(n));
  g.vec = (x,y,z) => ({x,y,z,__vec:true}); g.vector = g.vec;
  return { g, calls };
}

describe('createGlowFrontend', () => {
  it('constructs canvas, lights, sphere from the captured stream', () => {
    const { g, calls } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0); fe.handle(MSG1);
    const names = calls.map(c => c.name);
    expect(names).toContain('canvas');
    expect(names.filter(n => n === 'distant_light').length).toBe(2);
    expect(names).toContain('sphere');
  });

  it('converts vector-valued cfg entries via o2vec3', () => {
    const { g, calls } = stubGlow();
    createGlowFrontend({ container: null, send: () => {}, glow: g }).handle(MSG1);
    const sphere = calls.find(c => c.name === 'sphere');
    expect(sphere.cfg.color.__vec).toBe(true);          // [1,0,0] became a vec
    expect(sphere.cfg.size.__vec).toBe(true);
  });

  it('applies a compact attr code to the constructed object', () => {
    const { g, calls } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0); fe.handle(MSG1);                    // "a4a1,2,3" → idx 4 pos=(1,2,3)
    const sphere = calls.find(c => c.name === 'sphere');
    // handle_attrs mutates the registry object handle_cmds stored
    expect(fe._objs()[4].pos).toEqual(g.vec(1,2,3));
  });

  it('tolerates the cmd-less entry and the bare trigger handshake', () => {
    const { g } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    expect(() => { fe.handle(MSG0); fe.handle('trigger'); }).not.toThrow();
  });

  it('reset() clears the object registry', () => {
    const { g } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0);
    fe.reset();
    expect(Object.keys(fe._objs()).length).toBe(0);
  });
});
```

`_objs()` is a test-only accessor returning the internal `glowObjs` — document it as such in the source.

- [ ] **Step 2: Run to verify it fails** (module not found): container vitest command from Global Constraints, file-scoped.
- [ ] **Step 3: Write `glowcomm_host.js`.** Port from `glowcomm.js` with these transformations, and no others:
  - Wrap everything in `function createGlowFrontend(opts) { ... }`; `glowObjs` becomes a local; every bare constructor call (`sphere(cfg)`, `box(cfg)`, … — the whole switch at glowcomm.js:700-770) becomes `glow.sphere(cfg)` etc. via `var glow = opts.glow || globalThis;`.
  - Port verbatim (rename nothing): `o2vec3`, `fix_location`, `decode`, `handler` → the body of `handle(ops)` (add the `if (ops === 'trigger' || !ops) return;` guard), `handle_cmds`, `handle_methods`, `handle_attrs`.
  - DELETE: comm/websocket setup (:1-71), `fontloading`/`checkloading` (:72-117), `domessage`/`onmessage` (:118-149), `send`/`msclock`/`update_canvas` (:150-275 — event capture is Task 9's port), `send_to_server`/`ok` (:276-291), `send_pick`/`send_compound` (:292-310), `process`/`process_pause`/`process_waitfor`/`process_binding`/`control_handler` (:311-472 — Task 9).
  - Where deleted functions are referenced inside kept code (e.g. `handle_cmds` bindings calling `process_binding`, compound/pick paths calling `send_compound`/`send_pick`), replace the call with `opts.send && opts.send([...])`-shaped stubs guarded behind `if (typeof console !== 'undefined') console.warn('glowcomm_host: <feature> not wired yet')` — Task 9 replaces them. List every such site in the commit message.
  - Footer: `var api = { createGlowFrontend: createGlowFrontend }; if (typeof module !== 'undefined' && module.exports) module.exports = api; if (typeof self !== 'undefined') self.createGlowFrontend = createGlowFrontend;`
- [ ] **Step 4: Write `scripts/sync-vpython-worker.sh`** (trinket):

```bash
#!/usr/bin/env bash
# Copy the vpython-jupyter browser front-end + pure wheel into trinket's served
# components. Source of truth is the vpython-jupyter checkout — edit THERE.
set -euo pipefail
SRC="${VPJ:-$HOME/Development/glow-repos/vpython-jupyter}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/components/vpython-worker"
mkdir -p "$DEST"
cp "$SRC/vpython/vpython_libraries/glowcomm_host.js" "$DEST/"
WHEEL=$(ls "$SRC"/dist/vpython-*-py3-none-any.whl 2>/dev/null | tail -1 || true)
if [ -z "$WHEEL" ]; then
  echo "No pure wheel in $SRC/dist — build one:"
  echo "  cd $SRC && VPYTHON_PURE_PYTHON=1 SETUPTOOLS_SCM_PRETEND_VERSION=7.6.5 python3 -m build --wheel"
  exit 1
fi
cp "$WHEEL" "$DEST/"
echo "synced: $(ls "$DEST")"
```

Build the wheel in the vpython-jupyter checkout (command in the script's error text — note `dist/` may be gitignored there; that's fine), `chmod +x` the script, run it.
- [ ] **Step 5: Run the unit test to verify it passes.**
- [ ] **Step 6: Commit** — vpython-jupyter first (`feat: host-agnostic browser front-end ported from glowcomm.js`), then trinket (`feat(#vpython-worker): served front-end + wheel + sync script, unit-tested against captured stream`). Both with trailers.

### Task 2: The §16 canary — captured stream renders a real sphere on glow 3.2.3

**Files:**
- Create: `test/browser/specs/worker-vpython.spec.js` (trinket)

**Interfaces:**
- Consumes: `createGlowFrontend` global from `/components/vpython-worker/glowcomm_host.js`; trinket's served glow at `/components/vpython-glowscript/package/glow.3.2.3.min.js` (already provisioned in the dev container).
- Produces: the proof that decision V3 holds; the spec file later tasks extend.

- [ ] **Step 1: Write the canary spec:**

```js
const { test, expect } = require('@playwright/test');

// §16 canary (decision V3): the captured transport stream, the PORTED handler,
// and trinket's SERVED glow 3.2.3 — before anything is built on that combination.
// No worker involved: the fixtures are replayed directly on a blank embed page.
test.describe('Worker VPython (vpython-jupyter adoption)', () => {
  test('CANARY: captured sphere stream renders on trinket glow 3.2.3', async ({ page }) => {
    await page.goto('/embed/python3?runtime=main');   // any embed page; we just need a DOM + origin
    const result = await page.evaluate(async () => {
      const load = (src) => new Promise((ok, bad) => {
        const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad;
        document.head.appendChild(s);
      });
      await load('/components/vpython-glowscript/package/glow.3.2.3.min.js');
      await load('/components/vpython-worker/glowcomm_host.js');
      const holder = document.createElement('div');
      holder.id = 'canary-scene'; document.body.appendChild(holder);
      window.__context = { glowscript_container: $(holder) };
      const fe = self.createGlowFrontend({ container: holder, send: () => {} });
      fe.handle(JSON.parse(JSON.stringify(/* MSG0 fixture, verbatim */)));
      fe.handle(JSON.parse(JSON.stringify(/* MSG1 fixture, verbatim */)));
      // GlowScript renders into a <canvas> inside the container
      await new Promise(r => setTimeout(r, 1500));
      const cv = holder.querySelector('canvas');
      if (!cv) return { ok: false, why: 'no canvas element' };
      const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
      const px = new Uint8Array(4 * cv.width * cv.height);
      try { gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) {}
      let nonBg = 0;
      for (let i = 0; i < px.length; i += 4) { if (px[i] > 60 && px[i+1] < 60 && px[i+2] < 60) nonBg++; }
      return { ok: nonBg > 100, why: 'red pixels: ' + nonBg, w: cv.width, h: cv.height };
    });
    expect(result.why).toBeDefined();
    expect(result.ok).toBe(true);   // a red sphere occupies >100 pixels
  });
});
```

(The red-pixel count is the assertion: the fixture sphere is `color=[1,0,0]`. If `readPixels` returns all zeros under SwiftShader with a preserved-buffer issue, fall back to `cv.toDataURL()` length > blank-canvas baseline — decide in the loop, and record which assertion shipped.)
- [ ] **Step 2: Sync served files to the dev container's worktree** (Global Constraints "Serving") and run: `cd test/browser && ./node_modules/.bin/playwright test specs/worker-vpython.spec.js -g CANARY`. Expected first run: FAIL — iterate on port bugs (this is the canary doing its job). `window.__context` must be set BEFORE constructors run (glowcomm.js:776-778 is the reference).
- [ ] **Step 3: Get it green.** If glow 3.2.3 itself rejects a cfg the vendored glow accepts, STOP and report BLOCKED with the exact constructor + cfg diff — that's the V3 decision needing Steve, not something to patch around.
- [ ] **Step 4: Commit** (`test(vpython-worker): §16 canary — captured stream renders on served glow 3.2.3`).

### Task 3: Pin `GLOW_SRC` to 3.2.3

**Files:** Modify `public/js/embed/pyodide.js:23`; Test: existing `test/browser/specs/` main-thread vpython behavior.

- [ ] **Step 1:** Change `glow.3.2.2.min.js` → `glow.3.2.3.min.js` in `GLOW_SRC`, with a one-line comment: `// 3.2.3 = the rsWVPRunner GCS build the Dockerfile provisions; 3.2.2 was the stale components-tarball fallback (spec 2026-08-10, decision V3).`
- [ ] **Step 2:** Sync + run the existing main-path browser specs that execute VPython on main (`stop.spec.js` uses `?runtime=main`; run the full browser suite): all green.
- [ ] **Step 3: Commit** (`fix(pyodide): load glow 3.2.3 — same build as the glowscript embeds and the worker path`).

### Task 4: Router rule + `workerVPython` flag

**Files:** Modify `public/js/embed/runtime-router.js` (rule above the `usesVPython` rule at :7-9), `config/default.yaml` (features block), `docs/DEPLOY-OVERLAY-GUIDE.md`; Test: `test/unit/runtime-router.test.js`.

- [ ] **Step 1: Failing tests** (append to the existing describe):

```js
describe('workerVPython (opt-in worker path for VPython)', () => {
  it('routes VPython to the worker when the flag is on', () => {
    const r = chooseRuntime('from vpython import *\nsphere()', { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.runtime).toBe('worker');
    expect(r.reason).toMatch(/vpython.*worker|workerVPython/i);
  });
  it('flag off → VPython stays on main (D2 unchanged)', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: false });
    expect(r.runtime).toBe('main');
  });
  it('?runtime=main beats the flag (escape hatch)', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: true, queryRuntime: 'main' });
    expect(r.runtime).toBe('main');
  });
  it('?runtime=worker does NOT enable the vpython path by URL', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: false, queryRuntime: 'worker' });
    expect(r.runtime).toBe('main');
  });
  it('marks the decision so the kernel can install the wheel', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.vpython).toBe(true);
  });
  it('a non-vpython program is not marked', () => {
    expect(chooseRuntime('print(1)', OPTS).vpython).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In `chooseRuntime`, BEFORE the existing `if (opts.usesVPython)` rule:

```js
    // Opt-in (spec 2026-08-10 V1/V2): vpython-jupyter in the worker. The FLAG is
    // the only gate — ?runtime=worker must not opt a class in by URL — but
    // ?runtime=main still escapes (checked first, below? NO: main-escape must
    // win, so check queryRuntime==='main' here explicitly).
    if (opts.usesVPython && opts.workerVPython && opts.queryRuntime !== 'main') {
      return { runtime: 'worker', vpython: true, reason: 'vpython: workerVPython flag routes to the worker runtime' };
    }
```

`config/default.yaml`, under `features:` beside `workerRuntime`: `workerVPython: false  # Run Web VPython through vpython-jupyter in the Web Worker (#108 follow-on). Opt-in; ?runtime=main escapes. See docs/superpowers/specs/2026-08-10-vpython-jupyter-adoption-design.md`. Add a short section to `DEPLOY-OVERLAY-GUIDE.md` mirroring the `workerRuntime` one (default false, what changes, that Stop discards the interpreter and the scene freezes).
- [ ] **Step 4:** `chooseRuntime` callers: in `pyodide.js`'s `startRun` routing block, pass `workerVPython: !!(window.trinket && window.trinket.config && window.trinket.config.workerVPython)` beside `workerEnabled`, and carry `decision.vpython` into the run call (Task 5 consumes it).
- [ ] **Step 5: Run unit suite → green. Commit** (`feat(router): workerVPython flag routes VPython to the worker — flag-only gate`).

### Task 5: Kernel installs the wheel for vpython runs; generation tagging

**Files:** Modify `public/js/embed/pyodide-worker.js`, `public/js/embed/worker-client.js`, `public/js/embed/pyodide.js` (run call); Test: `test/unit/worker-client.test.js` (message shape), browser check in Task 7.

**Interfaces:**
- Consumes: `decision.vpython` from Task 4; wheel at `/components/vpython-worker/<name>.whl`.
- Produces: run message gains `{vpython: true, wheelUrl, sceneGeneration}`; every `scene-ops` post gains `generation`; client run API signature `run(source, files, serialized, extras)` where `extras = {vpython, wheelUrl, sceneGeneration}` (or however run() currently takes options — extend, don't break existing callers; check `test/unit/worker-client.test.js` for the current contract first).

- [ ] **Step 1: Failing unit test** (worker-client): posting a run with extras includes them in the postMessage; scene-ops routed to onSceneOps regardless of `current` (exists — keep green).
- [ ] **Step 2: Kernel implementation:**

```js
    // vpython runs execute against the vpython-jupyter wheel (spec 2026-08-10).
    // Idempotent per worker: micropip is a no-op if already installed.
    var vpythonReady = null;
    function ensureVPython(wheelUrl) {
      if (vpythonReady) return vpythonReady;
      vpythonReady = pyodide.loadPackage(['numpy', 'micropip']).then(function() {
        pyodide.globals.set('__vpy_wheel__', wheelUrl);
        return pyodide.runPythonAsync(
          'import micropip\n' +
          'await micropip.install(__vpy_wheel__, deps=False)\n'
        );
      });
      return vpythonReady;
    }
```

In `run(msg)`: if `msg.vpython`, `sceneGeneration = msg.sceneGeneration|0` (kernel-scope var), and chain `ensureVPython(msg.wheelUrl)` before the transform/exec chain. Tag: `self.__trinket_vpython_send = function(jsonStr) { post({ type: 'scene-ops', id: currentRunId, generation: sceneGeneration, ops: String(jsonStr) }); };` (replace the spike's untagged version).
- [ ] **Step 3:** Page: in the worker run call, pass `{vpython: decision.vpython, wheelUrl: '/components/vpython-worker/' + VPYTHON_WHEEL_NAME, sceneGeneration: vpythonGeneration}` — `VPYTHON_WHEEL_NAME` is a const beside `GLOW_SRC` naming the exact wheel file (keep in step with the sync script).
- [ ] **Step 4: Unit suite green; sync; commit** (`feat(worker): install the vpython wheel for routed runs; generation-tag scene-ops`).

### Task 6: Transport patches — eager boot, async rate/sleep, loud stubs (vpython-jupyter)

**Files:** Modify `vpython/trinket_worker.py`, `vpython/__init__.py`; Create `tests/test_trinket_worker.py`.

**Interfaces:**
- Consumes: `rate = _RateKeeper2(...)` instance (`rate_control.py:270`) — patch the CLASS `__call__`; `sleep` (`vpython.py:4433`) busy-spins on `rate(60)` — must be REPLACED, not wrapped; `canvas.waitfor` (`vpython.py:3389`), `canvas.pause` (`:3403`), widget classes all subclass `controls` (`:3613` on) — one `controls.__init__` patch covers button/checkbox/radio/winput/menu/slider.
- Produces: under emscripten, `from vpython import *` yields: awaitable `rate` (returns a coroutine; the async transform inserts the `await`), awaitable `sleep`, raising `pause`/`waitfor`/widgets. Message text (exact, used by the Task 11 browser assertion): `"{name} is not supported in the worker runtime yet — run without the workerVPython flag to use it."`

- [ ] **Step 1: Failing CPython tests** (`tests/test_trinket_worker.py`) — fake the environment before import:

```python
import asyncio, sys, types
import pytest

@pytest.fixture()
def worker_env(monkeypatch):
    """Import vpython's worker transport bits with js/pyodide faked and WITHOUT
    the package's eager __init__ side effects (no scene, no real transport)."""
    sent = []
    js = types.ModuleType('js')
    js.__trinket_vpython_send = lambda s: sent.append(s)
    ffi = types.ModuleType('pyodide.ffi'); ffi.create_proxy = lambda f: f
    pyodide_mod = types.ModuleType('pyodide'); pyodide_mod.ffi = ffi
    monkeypatch.setitem(sys.modules, 'js', js)
    monkeypatch.setitem(sys.modules, 'pyodide', pyodide_mod)
    monkeypatch.setitem(sys.modules, 'pyodide.ffi', ffi)
    from vpython import trinket_worker as tw     # noqa: E402
    return tw, sent

def test_rate_returns_a_coroutine(worker_env):
    tw, _ = worker_env
    from vpython.rate_control import rate
    c = rate(30)
    assert asyncio.iscoroutine(c)
    asyncio.get_event_loop().run_until_complete(c)

def test_sleep_returns_a_coroutine(worker_env):
    tw, _ = worker_env
    from vpython import vpython as vp
    c = vp.sleep(0.01)
    assert asyncio.iscoroutine(c)
    asyncio.get_event_loop().run_until_complete(c)

def test_pause_raises_with_the_message(worker_env):
    tw, _ = worker_env
    from vpython import vpython as vp
    cv = object.__new__(vp.canvas)               # no full construction needed
    with pytest.raises(NotImplementedError, match="scene.pause"):
        vp.canvas.pause(cv)

def test_widgets_raise(worker_env):
    tw, _ = worker_env
    from vpython import vpython as vp
    with pytest.raises(NotImplementedError, match="button"):
        vp.button(text='go', bind=lambda: None)
```

Note: importing `trinket_worker` runs its bootstrap (GlowWidget + trigger) — with the fake `js` that's harmless and `sent` collects the boot flush; if module-level boot makes these tests awkward, split the patches into a `apply_worker_patches()` function called by the bootstrap AND importable alone — preferred structure anyway.
- [ ] **Step 2: Run** (`cd ~/Development/glow-repos/vpython-jupyter && python3 -m pytest tests/test_trinket_worker.py -v`) → fails.
- [ ] **Step 3: Implement in `trinket_worker.py`:**

```python
_DEFER = ("{name} is not supported in the worker runtime yet — "
          "run without the workerVPython flag to use it.")

def apply_worker_patches():
    """Make vpython's blocking surface cooperative (or loudly absent) for a
    single-threaded wasm host. Called from the transport bootstrap; separated so
    plain-CPython tests can exercise the patches without a live transport."""
    import asyncio
    from . import rate_control
    from . import vpython as _vp

    async def _async_rate(maxRate):
        baseObj.trigger()                      # flush buffered updates
        await asyncio.sleep(1.0 / max(float(maxRate), 1.0))

    # rate is a module-level INSTANCE bound into user namespaces at import time;
    # patching the class __call__ changes the already-bound object everywhere.
    rate_control._RateKeeper2.__call__ = lambda self, maxRate=100: _async_rate(maxRate)

    async def _async_sleep(dt):
        baseObj.trigger()
        await asyncio.sleep(dt)
    _vp.sleep = _async_sleep                   # BEFORE __init__'s star-import binds it

    def _deferred(name):
        def _raise(*args, **kwargs):
            raise NotImplementedError(_DEFER.format(name=name))
        return _raise
    _vp.canvas.pause   = _deferred('scene.pause')
    _vp.canvas.waitfor = _deferred('scene.waitfor')
    _vp.controls.__init__ = _deferred('widgets (button/slider/menu/checkbox/radio/winput)')
```

Correction to the widget test/message: `controls.__init__` is shared — the message names the family; adjust the widget test regex to `match="widgets"`. In `__init__.py`, immediately after `from .vpython import canvas` and before `scene = canvas()`:

```python
import sys as _sys
if _sys.platform == 'emscripten':
    # Boot the wasm transport EAGERLY: its patches must land before the
    # star-imports below bind rate/sleep into the package namespace.
    from . import trinket_worker as _tw
del _sys
```

and in `trinket_worker.py`'s bootstrap call `apply_worker_patches()` before `baseObj.trigger()`. Verify the lazy path (`baseObj.__init__` selection from the packaging commit) still works — it now finds the module cached; keep it as the fallback.
- [ ] **Step 4: Tests green. Also rebuild the wheel + re-run trinket's sync script** (Task 1's) so later tasks test against these patches.
- [ ] **Step 5: Commit** (vpython-jupyter: `feat(worker): eager boot + async rate/sleep + loud deferrals for wasm hosts`).

### Task 7: Page host shim — real front-end replaces the spike summarizer

**Files:** Modify `public/js/embed/pyodide.js` (replace `handleWorkerSceneOps` + spike timer, add generation lifecycle + glow/front-end loading); Test: extend `test/browser/specs/worker-vpython.spec.js`.

**Interfaces:**
- Consumes: `createGlowFrontend` (served), `ensureGlow()` (`pyodide.js:755` — the existing main-path glow loader; reuse it), generation const from Task 5, `workerClient.sendSceneEvent` (exists).
- Produces: `vpythonGeneration` (int, incremented on each vpython run start), `resetVPythonScene()`, working end-to-end render from a real student program.

- [ ] **Step 1: Failing browser spec** (append; requires `features.workerVPython: true` in the dev stack's `config/local.yaml` — add a `test.skip` guard that probes the flag via a tiny run and reports a SKIP message telling the operator to enable it):

```js
  test('a real program renders a sphere via the worker', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, 'from vpython import *\nball = sphere(color=color.red)\n');
    await page.locator('.run-it').first().click();
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
      const n = await page.evaluate(() =>
        document.querySelectorAll('#glowscript-scene canvas, .glowscript canvas').length);
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 120_000 });
  });
```

(Adjust the canvas selector to whatever container the shim actually uses — Step 2 decides it; keep spec and shim in the same commit so they can't drift.)
- [ ] **Step 2: Implement the shim.** Replace the spike's `handleWorkerSceneOps` + `vpythonSceneTimer` wholesale:

```js
var vpythonFrontend = null, vpythonGeneration = 0, vpythonPacer = null;

function resetVPythonScene() {
  vpythonGeneration++;
  if (vpythonPacer) { clearInterval(vpythonPacer); vpythonPacer = null; }
  if (vpythonFrontend) { try { vpythonFrontend.destroy(); } catch (e) {} vpythonFrontend = null; }
  var holder = document.getElementById('vpython-scene');
  if (holder) holder.innerHTML = '';
}

function handleWorkerSceneOps(msg) {
  if (msg.generation !== vpythonGeneration) return;      // stale run's scene
  var gen = msg.generation;
  ensureVPythonFrontend().then(function(fe) {
    if (gen !== vpythonGeneration) return;               // reset raced the load
    var ops = null;
    try { ops = JSON.parse(msg.ops); } catch (e) { return; }
    fe.handle(ops);
    if (!vpythonPacer) {
      vpythonPacer = setInterval(function() {
        if (workerClient) workerClient.sendSceneEvent('[{"trigger":1}]');
        else { clearInterval(vpythonPacer); vpythonPacer = null; }
      }, 33);
    }
  });
}
```

`ensureVPythonFrontend()`: promise-memoized — `ensureGlow()` (reuses the main path's loader, now 3.2.3), then loads `/components/vpython-worker/glowcomm_host.js` by script tag, creates/finds `#vpython-scene` inside `#graphic` (same pane figures use), sets `window.__context = { glowscript_container: $(holder) }` before first `handle`, constructs the factory with `send: function(evts) { if (workerClient) workerClient.sendSceneEvent(JSON.stringify(evts)); }`. `startRun()`'s worker branch calls `resetVPythonScene()` when `decision.vpython` (before posting the run, so the generation it passes is the fresh one). `stopCode()`'s worker branch also clears the pacer (scene stays frozen — spec lifecycle).
- [ ] **Step 3: Sync, run the new spec + the canary + full existing browser suite. Iterate to green.**
- [ ] **Step 4: Commit** (`feat(vpython-worker): page host shim — real front-end, generation lifecycle, worker-path rendering end to end`).

### Task 8: The headline — rate() animation, Stop kills it, page responsive

**Files:** Test: `test/browser/specs/worker-vpython.spec.js`. (Implementation only if the spec finds bugs — likely candidates: transform application to vpython source in the kernel, trigger/flush pacing.)

- [ ] **Step 1: Spec:**

```js
  test('THE POINT: a rate() animation is killed by Stop, page responsive', async ({ page }) => {
    await page.goto('/embed/python3');
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, 'from vpython import *\nb = sphere()\nwhile True:\n    rate(60)\n    b.pos.x += 0.01\n');
    await page.locator('.run-it').first().click();
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 120_000 });
    // page must stay responsive while the loop runs
    const t0 = Date.now();
    await page.evaluate(() => document.title);
    expect(Date.now() - t0).toBeLessThan(2000);
    await page.locator('.stop-it').click();
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '')).toContain('[stopped');
    }).toPass({ timeout: 30_000 });
  });
```

- [ ] **Step 2: Run.** Expected wrinkle: the kernel must apply `_async_transform` to vpython-routed source (it transforms `rate(`/`sleep(` already — verify the vpython run path reaches the same transform the python3 path uses; if the transform import happens via the wvpython zip on main only, the kernel needs `transformUrl` handling for vpython runs too — trace `needsTransform`/`transformUrl` in `pyodide-worker.js` and extend minimally).
- [ ] **Step 3: Fix whatever it flushes out; suite green; commit** (`feat(vpython-worker): stoppable rate() animation — the #108 payoff for VPython`).

### Task 9: Mouse events — port the capture half, wire scene.bind round trip

**Files:** Modify `vpython/vpython_libraries/glowcomm_host.js` (port `update_canvas` :193-275, `process` :311-346, `process_binding` :373-380, `send` :150-170 — as factory-internal, using `opts.send`), re-sync; Test: unit (event shape) + browser (click handler fires).

**Interfaces:**
- Consumes: transport's `_dispatch` (exists — feeds `handle_msg`, which walks bound events and calls handlers; `vpython.py:394-425` is the reference); pacing loop from Task 7 (the ported `send` REPLACES the shim's bare-trigger pacer: on each tick it sends `update_canvas` events + trigger, exactly like glowcomm — coordinate with Task 7's `vpythonPacer`: once the front-end is live it owns pacing; the shim's interval calls `fe.tick()` which builds and sends the event array).
- Produces: `fe.tick()` (new factory method); clicking the scene calls a `scene.bind('click', f)` handler in the worker.

- [ ] **Step 1: Failing browser spec:**

```js
  test('scene.bind click handler fires in the worker', async ({ page }) => {
    await page.goto('/embed/python3');
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, 'from vpython import *\ns = sphere()\ndef hit(evt):\n    print("CLICKED", evt.pos)\nscene.bind("click", hit)\n');
    await page.locator('.run-it').first().click();
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 120_000 });
    await page.locator('#vpython-scene canvas').first().click({ position: { x: 100, y: 100 } });
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '')).toContain('CLICKED');
    }).toPass({ timeout: 30_000 });
  });
```

- [ ] **Step 2: Port the capture functions** (transform: module-globals → factory locals; `comm.send`/websocket send → buffered `opts.send(events)`), add `tick()`, adjust Task 7's pacer to call `fe.tick()` when available. Unit-test the event array shape (a canvas_update event carries the fields `handle_msg` reads — see `vpython.py:394-425` for the reader's expectations).
- [ ] **Step 3: Green; both repos' commits + re-sync.**

### Task 10: Graphs — gcurve/gdots render

**Files:** Test-first in `worker-vpython.spec.js`; fixes (if any) land in `glowcomm_host.js` (the cfg quirks for `gcurve`/`gdots` are already in the ported `handle_cmds` — `size` stays scalar for them; verify rather than assume).

- [ ] **Step 1: Spec:** program `from vpython import *\ng = gcurve(color=color.blue)\nfor x in range(50):\n    g.plot(x*0.1, x*x*0.01)\n`; assert a plot canvas/svg appears in the scene container and no console error line. (Graph objects render via glow's graph machinery — the container check is `#vpython-scene canvas` count ≥ 1 or a `.glowscript` graph div; pin the selector after seeing the DOM.)
- [ ] **Step 2: Run; fix cfg handling if it fails; green; commit.**

### Task 11: Lifecycle + loud deferrals, end to end

**Files:** Test: `worker-vpython.spec.js`; fixes in the shim/transport as flushed out.

- [ ] **Step 1: Specs:**

```js
  test('re-run replaces the scene instead of stacking a second one', async ({ page }) => {
    // run sphere program (helper from earlier specs), wait for 1 canvas,
    // click run again, wait, assert canvas count in #vpython-scene is still 1
  });
  test('scene.pause() reports the deferral clearly', async ({ page }) => {
    // program: from vpython import *\nsphere()\nscene.pause()\n
    // assert console output contains "not supported in the worker runtime yet"
    // and does NOT hang (run settles / stop button hides within the timeout)
  });
```

Write these fully (the helper extraction from the repeated run-program pattern belongs in this task — hoist `runVPython(page, src)` to the top of the spec file and refactor the earlier tests to use it).
- [ ] **Step 2: Green; commit** (`test(vpython-worker): lifecycle — re-run replaces, deferrals are loud`).

### Task 12: Docs + full-suite gate

**Files:** `docs/DEPLOY-OVERLAY-GUIDE.md` (verify Task 4's section reads true after implementation), spec's testing section cross-check; both repos' full test suites.

- [ ] **Step 1:** Full trinket unit suite (container) — green. Full browser suite — green (record counts). vpython-jupyter pytest — green.
- [ ] **Step 2:** Update `docs/superpowers/specs/2026-08-10-vpython-jupyter-adoption-design.md` with a short "Implementation notes" addendum ONLY where reality diverged from the spec (canvas selector, pacing ownership, transform wrinkles from Task 8). No divergence → no addendum.
- [ ] **Step 3:** Final commits both repos; report: branch states, test counts, what Steve should try on 3001, and the M&I-sample-selection action item (with Todd) for the trials gate.

## Self-Review (done at write time)

- **Spec coverage:** V1→Task 4 (flag) + untouched-bridge constraint; V2→Tasks 1/9 (factory in vpython-jupyter, trinket-free); V3→Tasks 2/3 (canary then pin); V4→Tasks 6/8; V5→Tasks 9/10/11 (mouse, graphs, deferrals); V6→Task 1 (port transformations enumerated); V7→Tasks 5/7/11 (generation). Errors section→Tasks 6/11 (message text pinned, traceback path untouched). Testing section→Tasks 1/2/8/9/10/11. Rollout→Task 12 report.
- **Placeholders:** Task 2 Step 3 and Task 8 Step 2 contain conditional STOP/trace instructions rather than code — deliberate: they are the two spots where reality may contradict the spec (V3 risk, transform reach), and the instruction is *what to do when it does*. Fixture comments say "verbatim" where the exact bytes appear once in the File Map rather than four times.
- **Type consistency:** `createGlowFrontend({container, send, glow})` / `{handle, reset, destroy}` + Task 9's `tick()` — consistent across Tasks 1/2/7/9. `decision.vpython` (4) → run extras (5) → kernel `msg.vpython` (5) → `ensureVPython` (5). `vpythonGeneration` (5/7) matches kernel `sceneGeneration` echo as `msg.generation`. Deferral message text identical in Task 6 code and Task 11 assertion substring.
