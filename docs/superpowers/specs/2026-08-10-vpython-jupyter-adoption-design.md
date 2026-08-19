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
| V5 | **v1 surface = M&I core:** objects + attributes, `rate()` animation, graphs (`gcurve`/`gdots`), mouse events via `scene.bind`. Deferred **loudly** (raise with a clear message): widgets, `scene.pause()`/`waitfor()`, **`compound()`, `text()`, `extrusion()`, `obj.clone()`, `scene.mouse.pick`**. | Covers the real course corpus without gating v1 on the hardest, least-used 20%. Every deferred item is the same defect: a synchronous wait, inside library code the transform never sees, for a browser reply that in a worker can only be delivered by the waiting thread. They need their own async patching, deferred. The list grew during implementation — `pause`/`waitfor` were the ones the spec knew about; the other five were found by auditing `vpython.py` for the same shape (see the implementation notes). |
| V6 | **Build shape = thin port of glowcomm.js** (approach A). Strip Jupyter/websocket edges, keep `handler`/`handle_cmds`/`handle_methods`/`handle_attrs`/`decode`/`o2vec3`/`update_canvas`, wrap in the factory. | Those 986 lines encode a decade of wire-format quirks (compact attr codes, per-constructor cfg fixups, event throttling). A port keeps them; a clean room re-learns them as rendering bugs. |
| V7 | **Python state persists across runs; the scene does not.** Per-run *generation* counter on the page; stale-generation ops dropped. **Amended — see V7a.** | Andrew's constraint from #127 applies here too: flipping a runtime flag must not change program semantics. Main-thread Python state persists across Run clicks; the worker path matches. The *scene* is rebuilt per run because re-execution constructs new objects anyway. |
| V7a | **AMENDMENT (Task 11, Steve's ruling): a *vpython* run gets a fresh interpreter.** Each Run discards the worker and boots a new one, so the Python namespace, the vpython scene and the page's object registry reset together. python3 runs are unchanged and keep accumulating state, so V7 stands everywhere else. | **This is the host's semantics, not a workaround.** Steve: *"Jupyter, Colab, and VS Code have a model where the kernel persists between runs… But in WebVPython.org and Trinket, there's no concept of 'persistent namespace' between runs."* Pressing Run here means "run this program from the top". A namespace surviving between Runs is a *notebook* affordance that this host does not offer, does not show anywhere in its UI, and cannot explain to a student — so V7's "flipping a runtime flag must not change program semantics" argues *for* the fresh interpreter on the vpython path, not against it: it is the main-thread bridge's behaviour, where every Run rebuilds the world.<br><br>vpython's design then makes the right thing unavoidable anyway. The package builds `scene = canvas()` **once**, at `import vpython`, and a surviving namespace memoizes that import — so on a warm worker run 2's objects attach to the canvas run 1 built, which the page destroyed when it bumped the generation, and run 2 draws **nothing**. Measured before the fix: generation 2, zero objects in the scene (the page's `handled` counter read 53, but it is cumulative across both runs and is not a per-run figure).<br><br>**Alternatives.** (a) *Keep run 1's canvas alive on the page* — that is the scene persisting across runs, contradicting the other half of V7 and leaving one scene accumulating every Run's objects. Rejected. (b) *Re-run vpython's module-level scene construction from the page each Run.* This was **viable** — Steve owns vpython-jupyter and this plan already patches it (`apply_worker_patches`), so "package internals" is not the objection. It loses on scope, not on access: it resets `scene` and the canvas, but not the student's own module-level state, so it would deliver a *partial* reset — `scene` fresh, their globals stale — which is the semantics hardest to explain and to test, and it would need re-deriving every time upstream vpython changes how the default canvas is built. Fresh-per-run gets the same result from one line and one mechanism.<br><br>**Cost — measured, not assumed.** ~4 s per vpython Run on the dev stack (run 1 4.1 s, run 2 3.9 s). Two halves, and the *transfer* half is the surprising one: on run 2 Pyodide's own artifacts (2.4 MB `python_stdlib.zip`, 2.7 MB `pyodide.asm.wasm`, 3.1 MB numpy) all come from the browser cache — they are cross-origin from jsdelivr with sane cache headers — while **our wheel is refetched in full, all 3,516,355 bytes**, because `app.js:65` applies `private, no-cache, **no-store**, must-revalidate` to *every* response trinket sends, in every environment. The wheel does carry an etag and a conditional GET returns 304/0 bytes, so the **cheapest lever by far is exempting `/components/` from that blanket policy** — a narrow change in the `onPreResponse` extension that would help every embed asset, not just this one. It matters more on a real deploy than on localhost, where 3.5 MB same-origin is nearly free. The remaining (compute) half's lever is a **pre-booted standby worker** — boot the replacement while the student is still reading run N's output — at the price of a second resident Pyodide (~100 MB+) in every embed. Neither is taken now; both are recorded as the follow-ups if the cost bites.<br><br>**Retained:** the generation counter, unchanged — `terminate()` does not un-post messages already queued for the page. |

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
- `runtime-router.js` — one new rule above D2's: `usesVPython(source) && workerVPython → 'worker'`. Precedence, explicitly: `?runtime=main` beats everything (escape hatch unchanged); `workerVPython` is **independent of `workerRuntime`** (a deploy can worker-ize VPython without worker-izing plain python3, and vice versa); `?runtime=worker` alone still does **not** send VPython to the worker — the flag is the only gate, so an embed link can never opt a class into the experimental path by URL. The existing lambda/comprehension guard applies to this rule too (see the implementation notes). Pure, unit-tested.
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
- Deferred features (`pause`, `waitfor`, widgets) → raise `NotImplementedError` with: *"scene.pause() is not supported in the worker runtime yet — run without ?runtime=worker (or ask your instructor to disable workerVPython) to use it."* ⚠️ **This wording was never shipped and its `?runtime=worker` advice is wrong — see the implementation notes at the end for what `trinket_worker.py` actually says.** A normal traceback shows the student the offending line. No silent no-ops: a pause that doesn't pause corrupts program meaning.

## Testing

- **Unit (node):** the ported `handle_cmds`/`handle_attrs` against a stub glow (recorded constructor calls), fed the **captured wire packages from the channel spike** — real canvas/lights/sphere/attr bytes, not hand-written fixtures. Router-rule tests. Transport-side: async-rate substitution and the loud stubs, testable in plain CPython with a fake `js` module.
- **Browser (Playwright, both runtimes where meaningful):** sphere renders (WebGL canvas exists, non-blank); **a `rate()` animation is killed by Stop with the page responsive throughout** — the #108 payoff extended to VPython, and the headline test; `scene.bind('click')` handler fires; `gcurve` draws; re-run replaces the scene rather than stacking; `scene.pause()` yields the clear message.
- **First implementation task is the §16 canary:** captured sphere stream → ported handler → trinket's served glow 3.2.3 → a rendered sphere, before any other task builds on V3. If it misrenders, the two builds are the *same source* — diff mechanically and decide then.

## Rollout and success criterion

Flag off everywhere by default; trials enable it in untracked `local.yaml`. Success: a representative set of programs renders and **animates correctly** on both trials, and Stop kills each of them mid-animation. Only then does "should this become the default" become a question, and it is not this spec's question.

**Which programs — corrected 2026-08-11 (Steve).** This flag engages *only* on the `python3` / `pyodide` type: `usesVPython()` lives in `pyodide.js`, and the `glowscript` type never loads that file (it runs RapydScript + `RSrun.min.js`). So the acceptance set is **Python trinkets that import the `vpython` module**, not the Web VPython corpus.

Steve's priority, verbatim in effect: *"Ultimately I think glowscript trinkets will want to use this path, but it's not urgent. Our more urgent need is for the python/pyodide trinkets to be able to use the vpython module in the worker context."*

Two consequences:

1. **The urgent need is what this spec built.** A Python trinket using `vpython` now runs off the main thread, animates under `rate()`, and is stoppable — which the main-thread bridge could never offer.
2. **Routing the `glowscript` type through this path is the eventual destination, and is out of scope here.** It is a much larger change than a flag: that type has no Pyodide at all today, so it would mean running a Python interpreter where RapydScript transpilation runs now. Recorded so the direction is not lost, not planned.

⚠️ **This changes what decision V5's deferrals cost.** V5 scoped v1 to "M&I core" and deferred `compound()`, `text()`, `extrusion()`, `scene.mouse.pick()`, `obj.clone()`, widgets and `pause`/`waitfor` on the grounds that the M&I course corpus rarely uses them. That justification was about *Web VPython course material*. The actual audience is general Python-trinket authors using `vpython`, whose usage profile is not the same — `text()` and `compound()` in particular are ordinary things to reach for. The deferrals remain **loud** (a clear `NotImplementedError`, never a silent failure or a hang), so nothing is unsafe; but which of them to implement next should be decided against this audience rather than against the M&I corpus.

> **Amended 2026-08-10.** This read "animates identically to the main path" until implementing `rate()` compensation showed the main path is the one that paces wrongly: GlowScript's own `rate()` sleeps a flat `1000/N` ms regardless of what the loop body cost, so a heavy loop runs slow there and at its requested rate here (measured: 38.0 Hz vs 54.6 Hz for `rate(60)` with an 8 ms body). Holding the worker to "identical" would have meant reproducing that bug deliberately. The worker matches upstream desktop VPython, which is what a student's program was written against; GlowScript's flat `rate()` is **to be filed** separately against the main-thread path. See caveat 5 in `docs/DEPLOY-OVERLAY-GUIDE.md` for the full measurements.

## Namespace rule (added 2026-08-10, Steve's ruling)

Both paths run student code with **no implicit imports**. The main-thread path
did not, until this was fixed: `ensureVpython()` ran `from math import *`,
`from random import *` and `from vpython import *` before any program that
`usesVPython()` matched — seeding copied from wmWVPRunner — and `runVpython()`
seeded bare `scene` / `rate` globals on top.

The rule, stated by trinket type rather than by source contents:

* **Web VPython (`glowscript`)** — VPython names by construction. The RapydScript
  compiler treats `from vpython import *` as the default (`GScompiler.js:503`)
  and hands `random` to RapydScript-NG. Correct as-is; that is the environment.
* **Python (`python3` / `pyodide`)** — explicit imports only. A Python trinket is
  a Python trinket whatever library it uses.

So the worker's strictness is **not a regression to be patched for parity** — it
is the rule arriving by accident, and the main-thread seeding is the defect. A
program relying on the seeding (`import vpython as vp`, then a bare `color.red`)
fails in desktop VPython, in a notebook and in plain Python; only trinket's
main-thread path props it up.

Found by running a real program of Steve's, which is also why it was missed: every
spec in this plan writes `from vpython import *` explicitly, so none of them
exercised the seeded namespace.

**Done 2026-08-10.** The seeding is gone from the main-thread path: the three
star-imports and the two bare globals. What stays is the module re-pointing
(`_vpy.scene = _vpy.canvas(...)`, `_vpy.rate = _wrapped_rate`) — module
attributes seed nothing, and they are how a student's own `from vpython import *`
still receives the current canvas and the cancellation-wrapped `rate`, which is
what keeps Stop able to kill a main-thread animation. This is a live-behaviour
change to the DEFAULT runtime, independent of the `workerVPython` flag; see
known-gap 7 in `docs/DEPLOY-OVERLAY-GUIDE.md` for the deploy-facing write-up and
`test/browser/specs/vpython-namespace.spec.js` for the contract.

---

## Non-goals

Widgets; `pause`/`waitfor`; JSPI fast path; changing the default path or removing the bespoke bridge; slim wheel (the 3.5 MB wheel bundles textures + a redundant glow — worth trimming later); wasm `cyvector` (perf, recipe exists in webvpython AGENTS.md); actual VS Code/Colab host shims (the factory API just must not preclude them); upstreaming the packaging changes to PyPI (Bruce/John conversation, separate).

## Risks

| Risk | Mitigation |
|---|---|
| glow 3.2.3 rejects some cfg the vendored glow accepted | Canary task first; same-source builds diff mechanically |
| Event round-trip latency makes dragging feel bad | Events ride the existing ~33 ms pacing, same rhythm as Jupyter vpython today; measure on the trials before judging |
| Transform misses a yield in a real M&I program → worker starves | The M&I sample set is the gate; any starving program routes to main via `?runtime=main` while diagnosed |
| Two-repo coordination (wheel version ↔ front-end version) | Wheel filename carries the version; host shim logs both at boot; single owner (Steve) for both repos |

## Implementation notes (Task 12) — where the build diverged from the text above

Only divergences are recorded. Decisions V1–V7 held as written except where V7a
already amends them, and the T7/T11 "Built shape" note above already records the
pacing-ownership and `solicited`-flag design.

- **The transform did not "apply unchanged" — it had to be *forced*.** The
  Ownership section says the worker kernel installs the wheel and "the existing
  `_async_transform` applies unchanged". The transform itself is indeed
  untouched, but it was never *reaching* a vpython run: `pyodide-worker.js`
  decided whether to transform by pattern-matching the source (`needsTransform`),
  and vpython source does not look like the python3 source that predicate was
  written for. With no transform there is no `await` on `rate()`, the flush
  inside `_async_rate` never runs, the worker never yields to its event loop, and
  **nothing rendered at all** — not even the objects built before the loop
  (Task 8). The fix is `wantsTransform(msg, src) = !!msg.vpython ||
  needsTransform(src)`: the router's own vpython decision forces it on. Widening
  the regex instead was rejected because `_BASE_AWAIT_NAMES` holds the *bare*
  names `rate`/`sleep`, so a python3 program defining its own `rate()` would have
  had `await` inserted in front of a plain value — that route can break a working
  program, `msg.vpython` cannot.
  - **Consequence, documented in the deploy guide rather than fixed here:**
    `from time import sleep` in a vpython program now gets an `await` and raises
    `TypeError`. Not a regression — the main-thread bridge shares the transform
    and does the same — but newly reachable. The fix belongs in
    `_async_transform.py` (35-test suite, upstream sync obligation), not in the
    worker kernel.
- **The lambda/comprehension guard had to be added to the vpython rule, and it
  matters more there than where it came from.** The rule sits above the query
  rules by design, which also put it above `hasUnawaitableCall(source)`. On the
  python3 path an un-awaited `input()`/`rate()`/`sleep()` is merely a
  synchronous call; in a vpython worker run those names are coroutine
  *factories*, so a call the transform could not reach builds a coroutine and
  discards it — no flush, no pacing, no yield, nothing rendered, and a hot spin.
  The flag would have turned a program that works on the main thread into a dead
  one, for exactly the shape the guard exists to catch. The rule now carries
  `&& !hasUnawaitableCall(source)` and falls through to `usesVPython → main`.
- **The console can change the scene, but only because the page now pings after
  each statement.** The transport is request/reply and the pacing clock belongs
  to the *run*, which has ended and drained by the time anyone types; `pushRepl`
  posts a plain `run` and nothing else. So `ball.color = color.blue` at the
  prompt executed, buffered, and rendered only if some unrelated browser event
  happened to flush it. `pyodide.js` sends one `[{"trigger":1}]` when a REPL
  statement settles — the tick that statement is owed. Reaches only the
  both-flags configuration, where the REPL and the run share an interpreter.
- **Served path is `public/components/vpython-worker/`, not `vpython-wheel/`.**
  It holds the front-end JS *and* the wheel, and `scripts/sync-vpython-worker.sh`
  is the only writer (source of truth is the vpython-jupyter checkout).
- **The two-repo mitigation needed a third leg to actually work.** The Risks
  table says *"wheel filename carries the version; host shim logs both at
  boot"*. The filename did; the log did not exist, and the front-end had no
  version to log — so "which build is this deploy serving?" was answerable only
  by unzipping the wheel. Now: `glowcomm_host.js` carries
  `GLOWCOMM_HOST_VERSION` (exposed as `createGlowFrontend.version`), the page
  logs `[vpython] worker path: front-end <v>, wheel <file>` once when the
  front-end loads, and — the leg the spec did not anticipate —
  `sync-vpython-worker.sh` refuses to sync at all unless the built wheel's
  filename matches `VPYTHON_WHEEL_NAME` in `pyodide.js` and its version matches
  the front-end's. The hand-duplicated filename was the real hazard: a bump on
  one side alone is a run-time 404 that surfaces as a generic site error. The
  script also deletes stale wheels rather than leaving 3.5 MB copies to be
  committed by accident.
- **At program end the pacing clock stops; the scene stays live anyway.** The
  Scene lifecycle section says the transport "keeps answering pacing triggers"
  after the program ends. It does not: the clock belongs to the *run*, so
  `finishVPythonPacing()` drains and then stops it. The stated outcome still
  holds by a different mechanism — the rendered scene is client-side glow, so
  orbit/zoom/pan keep working with no worker involved, and the archetypal
  interactive program (`scene.bind('click', f)` then end-of-file) works because
  the front-end **self-flushes an event when no tick has happened within 100 ms**
  instead of queueing it for a clock that will never come round again (T9).
- **The factory's shipped API is wider than V2 and the Ownership bullet pin.**
  Built: `createGlowFrontend({container, send, glow})` →
  `{handle, tick, poll, pacingStopped, reset, destroy, _objs}`. Two of those
  matter to V2's host-agnostic purpose and are not in the spec's
  `{handle(opsObject), reset(), destroy()}`:
  - `glow` (optional, defaults to `globalThis`) — the GlowScript constructor
    registry is injected rather than read off the window, which is what lets a
    node unit test drive the factory against a stub and what would let a second
    scene, or a host that namespaces glow, work at all.
  - **`pacingStopped()` is a HOST OBLIGATION, not a convenience** — and the
    reason is narrower than "events would be lost", because they would not be.
    The clock belongs to the run, so the front-end already self-flushes any event
    arriving more than `PACING_GRACE_MS` (~100 ms) after the last tick; that is
    the backstop for a host that forgets, and it is what makes the bullet above
    true. What the backstop cannot cover is the window it defines: an event
    arriving **within** that ~100 ms still looks like it has a tick coming, so it
    is queued for one that never arrives and sits there until some later event
    happens to flush it. Only the host knows the clock has stopped, so only the
    host can close that window — `pacing_stopped()` sets `last_tick = -Infinity`
    and flushes. A VS Code or Colab host that implements `{container, send}` and
    `handle/reset/destroy` to the letter and skips this does not lose a click; it
    **delays** one landing in that window, indefinitely and invisibly, which is
    the worse bug to diagnose. The 100 ms grace is a backstop, not the contract.
    `tick()`/`poll()` are the same seam from the other side: the host decides
    *when*, the front-end decides *what*.
- **The deferral list is longer than V5 first said — five more constructs, found
  by audit rather than by test.** The spec named widgets, `pause` and `waitfor`,
  reasoning from "spin on sync `rate(30)` inside library code the transform never
  sees". That reasoning is right and it does not stop there: `compound()`
  (`while not baseObj.sent: time.sleep(0.001)`), `text()`, `extrusion()` and
  `scene.mouse.pick` (all via `_wait()`), and `obj.clone()`
  (`while not baseObj.empty(): rate(60)`) have exactly the same shape. All five
  now raise the same `_DEFER` message naming themselves, and V5's surface list
  above is amended to match.
  - Two things made this worth chasing rather than leaving as a known rough
    edge. **`compound` and `text` are common in the M&I corpus**, so a validation
    run would have hit them early. And this branch made the failure *worse*:
    `_wait()` polls with `rate(30)`, and `rate` is now a coroutine factory, so
    called from synchronous library code it builds a coroutine and discards it
    without ever sleeping — the hang became a 100% CPU hot spin with no yield.
    Either way the student sees no scene, no error and a working Stop button,
    which is the silent no-op the Errors section forbids.
  - `_wait` itself is patched too, as a backstop: those four are every caller in
    the package today, and a future one should say so rather than hang.
- **The Errors section quotes a deferral message that was never shipped, and it
  names an escape that does not exist.** The spec has *"…not supported in the
  worker runtime yet — run without `?runtime=worker` (or ask your instructor to
  disable workerVPython) to use it."* `?runtime=worker` has never been the way
  into this path (the flag is the only gate — see the router rule above), so that
  advice would send a student to a URL parameter that changes nothing. What
  actually ships, in `trinket_worker.py`'s `_DEFER`, is:
  *"{name} is not supported in the worker runtime yet — run without the
  workerVPython flag to use it."* The shipped text is the correct one; the spec's
  is corrected here rather than in the code.
