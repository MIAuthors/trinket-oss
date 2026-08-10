# Worker VPython via vpython-jupyter — Design

**Date:** 2026-08-10
**Predecessors:** §14–16 of `2026-08-08-pyodide-worker-runtime-design.md` (the proposal and its evidence); `2026-08-09-vpython-jupyter-pyodide-spike.md` (packaging spike); the transport + channel spikes (vpython-jupyter `9cfb2e4`, trinket `a40c3e2`), both verified against the real #108 worker.

**Goal:** An opt-in path where Web VPython programs run through the `vpython-jupyter` package in the #108 Web Worker, rendered by GlowScript on the page — so a VPython animation is killable by Stop and the page never freezes, using the maintained object protocol instead of the bespoke bridge.

**What the spikes already proved** (none of this is speculative): the pure wheel installs and imports in the worker; the object protocol runs there; the `trinket_worker` transport boots and flushes; the `scene-ops`/`scene-event` channel carries constructor and attribute packages end-to-end with browser-side pacing.

---

## Decisions

Settled with Steve during design; recorded so the plan doesn't relitigate them.

| # | Decision | Rationale |
|---|---|---|
| V1 | **Opt-in.** The bespoke main-thread bridge stays the default, untouched. This path ships behind `features.workerVPython` (default off). | The bridge serves M&I courses in production. Replacement is a later decision made on evidence from the trials. |
| V2 | **The browser half lives in vpython-jupyter, host-agnostic.** A factory `createGlowFrontend({container, send})` beside `glowcomm.js`; trinket injects the pipe. | Steve owns the repo; the identical piece is what VS Code and Colab hosts need; keeping trinket-isms out of the seam is the "marriage" (§15). |
| V3 | **Trinket's served GlowScript (glow 3.2.3) renders the scene.** One glow per page. | Checked, not assumed: trinket's 3.2.3 is byte-identical to the GCS artifact; vpython-jupyter's vendored glow.min.js is the *same 3.2 source line* with different dependency packaging (browserify bundle vs lean clipper; divergence at byte 54,076, identical shader tail). Constructor API expected compatible; the canary task (T-first below) verifies before anything is built on it. |
| V4 | **`rate()` becomes async via the existing `_async_transform`.** The transport replaces `vpython.rate` with: flush, then `await asyncio.sleep(dt)`. | No threads in a worker: blocking sleep starves `onmessage`, so events and pacing never dispatch. The transform already awaits `rate(` (comprehensions included; lambdas route to main as today), so program compatibility matches the current bridge. JSPI/`run_sync` is a future capability-detected fast path, not v1. |
| V5 | **v1 surface = M&I core:** objects + attributes, `rate()` animation, graphs (`gcurve`/`gdots`), mouse events via `scene.bind`. Widgets and `scene.pause()`/`waitfor()` are deferred **loudly** (raise with a clear message). | Covers the real course corpus without gating v1 on the hardest, least-used 20%. `pause`/`waitfor` spin on sync `rate(30)` inside library code the transform never sees — they need their own async patching, deferred. |
| V6 | **Build shape = thin port of glowcomm.js** (approach A). Strip Jupyter/websocket edges, keep `handler`/`handle_cmds`/`handle_methods`/`handle_attrs`/`decode`/`o2vec3`/`update_canvas`, wrap in the factory. | Those 986 lines encode a decade of wire-format quirks (compact attr codes, per-constructor cfg fixups, event throttling). A port keeps them; a clean room re-learns them as rendering bugs. |
| V7 | **Python state persists across runs; the scene does not.** Per-run *generation* counter on the page; stale-generation ops dropped. **Amended — see V7a.** | Andrew's constraint from #127 applies here too: flipping a runtime flag must not change program semantics. Main-thread Python state persists across Run clicks; the worker path matches. The *scene* is rebuilt per run because re-execution constructs new objects anyway. |
| V7a | **AMENDMENT (Task 11, Steve's ruling): a *vpython* run gets a fresh interpreter.** Each Run discards the worker and boots a new one, so the Python namespace, the vpython scene and the page's object registry reset together. python3 runs are unchanged and keep accumulating state, so V7 stands everywhere else. | V7 as written cannot be implemented for vpython: the package builds `scene = canvas()` **once**, at `import vpython`, and the import is memoized by the surviving namespace. On a re-run the student's objects therefore attach to the canvas built by run 1 — which the page destroyed when it bumped the generation — so run 2 draws **nothing**. Measured before the fix: generation 2, 53 packages handled, zero objects on the page. The alternatives were (a) make the page keep run 1's canvas alive, which is the scene persisting across runs and contradicts the other half of V7, or (b) rebuild vpython's module-level scene from the page, which means reaching into package internals per-run. Discarding the interpreter is what Stop already does, which is why "stop, then run again" has always worked. **Cost:** a cold Pyodide boot plus the 3.5 MB wheel install on every vpython Run (~5 s on the dev stack, browser-cached) — accepted. **Semantics:** the generation counter is still required; terminate() does not un-post messages already queued for the page. |

---

## Architecture

```
WORKER (Pyodide)                          PAGE (trinket embed)
─────────────────────────                 ──────────────────────────────
vpython  (pure py3-none-any wheel)        glowcomm_host.js  (vpython-jupyter)
 └ trinket_worker transport                 createGlowFrontend({container, send})
    sender ──→ postMessage ──ops──────→     handler → handle_cmds/methods/attrs
    dispatch ←── postMessage ←─events──     update_canvas: mouse state + pacing
        (kernel forwards both ways:             │
         scene-ops / scene-event,               ▼
         reserved since protocol v1)        GlowScript — trinket's glow.3.2.3
                                            (same bundle the main path uses)
```

The spike's page-side `setInterval` pacing loop is **removed**: the ported front-end brings glowcomm's own `send()` loop, which is the real pacing (~33 ms) plus mouse-state capture in one place. The kernel and client `scene-ops`/`scene-event` plumbing from the channel spike is kept as-is.

> **Built shape (T7/T11).** The *page* ended up owning WHEN a tick happens and the front-end WHAT is in it (`tick()`), because the clock belongs to the **run**, not to the scene. There are then **two clocks**: this pacer, and `rate()` inside the student's loop, which flushes on its own up to `rate_control.MAX_RENDERS` a second. While the program is flushing, the pacer's handshake is pure overhead (measured: 91 host messages against 254 packages over 3 s), so it switches to `poll()` — the browser's half of a tick, silent when there is nothing to say. "Flushing on its own" is a kernel flag (`solicited: false` on `scene-ops`), not a guess from message rates: the transport answers *every* trigger with a flush, so inbound traffic alone cannot tell a busy program from the page's own echo.

### Ownership

**vpython-jupyter** (branch `pyodide-packaging`, already carrying the wheel + transport work):
- `vpython/vpython_libraries/glowcomm_host.js` — the ported front-end factory. No Jupyter globals, no websocket, no trinket references. Interface: `createGlowFrontend({container, send})` returns `{handle(opsObject), reset(), destroy()}`; calls `send(eventsArray)` for browser events and pacing triggers.
- `vpython/trinket_worker.py` — grows: async `rate` replacement; loud stubs for `pause`/`waitfor`/widget constructors; already provides sender/dispatch.

**trinket:**
- `runtime-router.js` — one new rule above D2's: `usesVPython(source) && workerVPython → 'worker'`. Precedence, explicitly: `?runtime=main` beats everything (escape hatch unchanged); `workerVPython` is **independent of `workerRuntime`** (a deploy can worker-ize VPython without worker-izing plain python3, and vice versa); `?runtime=worker` alone still does **not** send VPython to the worker — the flag is the only gate, so an embed link can never opt a class into the experimental path by URL. Pure, unit-tested.
- `config/default.yaml` — `features.workerVPython: false`, documented beside `workerRuntime`.
- Worker kernel — when the router marked the run vpython: install numpy + the vpython wheel (idempotent per worker) before executing; the existing `_async_transform` applies unchanged.
- Page host shim (~50 lines in `pyodide.js`) — instantiate the factory on first `scene-ops` of a vpython run, `send = workerClient.sendSceneEvent`, `onSceneOps → frontend.handle(ops)`; generation handling; load glow 3.2.3 into the scene container on demand.
- Wheel served by trinket itself: versioned file under `public/components/vpython-wheel/` (no CDN, no PyPI dependency at runtime).
- The embed's `GLOW_SRC` pin moves `3.2.2 → 3.2.3` — closes the vintage drift found in §15/§16 and makes both paths render with the same build.

## Scene lifecycle

- **Run start:** page clears the scene container, increments the generation, resets `glowObjs`. Ops tagged with an older generation are dropped (a re-run re-executes the program and constructs fresh objects; attribute updates aimed at dead indices must not mis-render).
- **Program end:** the scene stays live — the transport keeps answering pacing triggers, camera interaction keeps working. This is why `scene-ops` is deliberately not run-scoped in `worker-client` (recorded in its comment).
- **Stop:** the worker terminates unconditionally (#108's contract). The scene freezes at its last frame — the correct artifact of killing an animation — and the console prints the existing `[stopped]` message. The next run clears it.

## Errors

- Wheel install/import failures → the existing stderr → #107-filtered traceback path.
- Front-end JS exceptions → console line + existing `collectErrorData` telemetry.
- Deferred features (`pause`, `waitfor`, widgets) → raise `NotImplementedError` with: *"scene.pause() is not supported in the worker runtime yet — run without ?runtime=worker (or ask your instructor to disable workerVPython) to use it."* A normal traceback shows the student the offending line. No silent no-ops: a pause that doesn't pause corrupts program meaning.

## Testing

- **Unit (node):** the ported `handle_cmds`/`handle_attrs` against a stub glow (recorded constructor calls), fed the **captured wire packages from the channel spike** — real canvas/lights/sphere/attr bytes, not hand-written fixtures. Router-rule tests. Transport-side: async-rate substitution and the loud stubs, testable in plain CPython with a fake `js` module.
- **Browser (Playwright, both runtimes where meaningful):** sphere renders (WebGL canvas exists, non-blank); **a `rate()` animation is killed by Stop with the page responsive throughout** — the #108 payoff extended to VPython, and the headline test; `scene.bind('click')` handler fires; `gcurve` draws; re-run replaces the scene rather than stacking; `scene.pause()` yields the clear message.
- **First implementation task is the §16 canary:** captured sphere stream → ported handler → trinket's served glow 3.2.3 → a rendered sphere, before any other task builds on V3. If it misrenders, the two builds are the *same source* — diff mechanically and decide then.

## Rollout and success criterion

Flag off everywhere by default; trials enable it in untracked `local.yaml`. Success: a representative set of M&I programs — **to be picked with Todd** — renders and animates identically to the main path on both trials, and Stop kills each of them mid-animation. Only then does "should this become the default" become a question, and it is not this spec's question.

## Non-goals

Widgets; `pause`/`waitfor`; JSPI fast path; changing the default path or removing the bespoke bridge; slim wheel (the 3.5 MB wheel bundles textures + a redundant glow — worth trimming later); wasm `cyvector` (perf, recipe exists in webvpython AGENTS.md); actual VS Code/Colab host shims (the factory API just must not preclude them); upstreaming the packaging changes to PyPI (Bruce/John conversation, separate).

## Risks

| Risk | Mitigation |
|---|---|
| glow 3.2.3 rejects some cfg the vendored glow accepted | Canary task first; same-source builds diff mechanically |
| Event round-trip latency makes dragging feel bad | Events ride the existing ~33 ms pacing, same rhythm as Jupyter vpython today; measure on the trials before judging |
| Transform misses a yield in a real M&I program → worker starves | The M&I sample set is the gate; any starving program routes to main via `?runtime=main` while diagnosed |
| Two-repo coordination (wheel version ↔ front-end version) | Wheel filename carries the version; host shim logs both at boot; single owner (Steve) for both repos |
