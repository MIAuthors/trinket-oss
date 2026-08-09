# Pyodide Worker Runtime — Design

**Issue:** [#108](https://github.com/PICUP-Physics/trinket-oss/issues/108) — a running program can freeze the tab, and Stop cannot always stop it.

**Goal:** Run student Python off the main thread so the page never freezes, and so Stop can halt *any* program — including `while True: pass`.

**Architecture:** A routed dual runtime. A pre-flight step inspects each program and chooses between today's in-window Pyodide (unchanged) and a new Web Worker kernel. The worker never touches the DOM; everything it needs from the page crosses a single typed message channel.

**Tech stack:** Pyodide (existing), Web Workers, `postMessage`. No `SharedArrayBuffer` — see [Constraint 1](#global-constraints).

---

## Global Constraints

These bind every task in the implementation plan.

1. **No `SharedArrayBuffer`.** `SAB` + `Atomics.wait` is the usual way to make worker input synchronous, and it requires cross-origin isolation. An iframe is only `crossOriginIsolated` if the **top-level page** is, so trinket embeds — the primary delivery vehicle — can never have it. Every design decision below assumes an asynchronous channel.
2. **No regression for VPython.** Web VPython / GlowScript is the feature this project's users depend on most (Matter & Interactions courses). v1 does not change how it executes.
3. **The worker never touches the DOM.** No `document`, no `window`, no direct GlowScript calls. Anything visual crosses the channel as a message.
4. **Existing output handling is reused, not reimplemented.** Tracebacks go through `formatPythonTraceback()` and `escapeConsoleHtml()` in `public/js/embed/pyodide.js`; console writes go through `writeOut()`.
5. **Opt-in until proven.** Ships behind a query parameter and a config flag, both default off.
6. **Message type names are fixed by this spec.** Use the exact strings in [Protocol](#4-protocol), including the reserved ones.

---

## 0. Dependencies and starting point

This design is written against **`smoke/phase1-2`**, not `picup/main`. Three symbols it reuses do not exist upstream yet; they are in open PRs:

| Symbol | Where it lives now | PR |
|---|---|---|
| `formatPythonTraceback()` | `fix/107-traceback-noise` | #117 |
| `escapeConsoleHtml()` | both #117 and #114 (defined in each) | #117 / #114 |
| REPL (`startRepl`, `consoleResult`, run-options menu) | `spike/109-pyodide-repl` | #114 |
| `SLEEP_CANCEL_CODE`, `stop-it` button | `feat/108-vpython-stop-clean` | #122 |

**Sequencing consequence:** implementation should start only after those merge, or on a branch that already contains them. Starting from `picup/main` would mean reimplementing traceback formatting and console escaping, and `escapeConsoleHtml` is currently duplicated across #114 and #117 — that duplicate must be resolved to a single definition when they land, before this project builds on it.

`usesVPython()` exists in all of them.

---

## 1. Problem, with evidence

Pyodide runs CPython compiled to WASM **synchronously on the main thread**, and WASM cannot be preempted. Measured in an embed:

| Program | Tab | Stop |
|---|---|---|
| `while True: print('.'); time.sleep(1)` | responsive | works |
| VPython loop with `rate(30)` | responsive | works |
| `while True: print('.')` | **frozen** | impossible |
| `while True: pass` | **frozen** | impossible |

Cancellation today is cooperative: `SLEEP_CANCEL_CODE` wraps `time.sleep` and `installRateCancellation()` wraps `rate`, each raising when a stop is requested. Both work only where the program *yields*. A loop with no yield point gives the page no opportunity to run, so the Stop button cannot even be clicked.

A worker fixes this by construction: execution is not on the UI thread, and `worker.terminate()` is unconditional.

---

## 2. Decisions

Settled during design; recorded with rationale so the plan doesn't relitigate them.

| # | Decision | Rationale |
|---|---|---|
| D1 | Off-main-thread execution, not just better cancellation | The goal is "the page never freezes", not only "Stop works". An AST-injected cancellation check would fix Stop while leaving the tab stuttering. |
| D2 | VPython stays on the main thread in v1 | Its bridge binds `from js import sphere, box, rate, …` synchronously to the window realm. Moving it is a *replacement*, not a port. |
| D3 | Programs the transform can't handle fall back to the main thread | Preserves today's behaviour instead of failing a program that works now. |
| D4 | matplotlib uses `backend_webagg_core` over `postMessage` | The `ipympl` architecture, which is how JupyterLite and VS Code get interactive figures from an out-of-process kernel. Keeps pan/zoom. |
| D5 | Interactive 3D in the worker is the committed destination; the channel is shaped for it now | Reserving the message types costs nothing today and keeps the later bridge additive rather than a transport rewrite. |
| D6 | Variable explorer and step debugger run in the worker too, not routed away | Both already serialise to JSON and are only read when Python is idle, so they port as a transport change with no logic change. An earlier draft routed them to the main thread, which would have disabled worker coverage site-wide for any deploy that enabled the explorer. |

**Explicitly not decided here:** how the VPython bridge itself is replaced. That is its own spec — see [Non-goals](#10-non-goals-and-what-comes-next).

---

## 3. Architecture — a routed dual runtime

The unit of decision is a **program**, not the site. Before running, `runtime-router.js` picks a runtime:

```
                    ┌─────────────────────────┐
   program source → │  chooseRuntime(source)  │
                    └───────────┬─────────────┘
                      'main'    │    'worker'
              ┌─────────────────┴───────────────┐
              ▼                                 ▼
   today's in-window Pyodide          pyodide-worker.js
   (VPython bridge, webagg)           (no DOM; messages only)
    Stop = cooperative                 Stop = terminate()

   variable explorer + step debugger work in BOTH:
   their payloads are already JSON (see 8a)
```

### Routing rules

Applied in order; the first match wins.

| Rule | Runtime | Reason |
|---|---|---|
| `usesVPython(source)` — already implemented in `public/js/embed/pyodide.js` | `main` | D2 |
| `input()` / `rate()` / `sleep()` inside a `lambda` or comprehension | `main` | `await` cannot be inserted there (documented in `_async_transform.py`) |
| `?runtime=main` | `main` | escape hatch |
| otherwise | `worker` | the common case |

`chooseRuntime()` is a **pure function of (source, config, query)** returning `'main' | 'worker'` plus a `reason` string for diagnostics. Pure means it is unit-testable in node with no browser and no Pyodide — the only part of this project that can be tested cheaply, so it carries the routing logic rather than letting it smear into `pyodide.js`.

---

## 4. Protocol

One channel, typed messages, versioned with a `v` field so a stale cached worker can be detected and replaced.

### page → worker

| Type | Payload | Notes |
|---|---|---|
| `init` | `{ v, pyodideUrl, packages }` | once per worker |
| `run` | `{ id, source, files }` | `id` correlates every reply |
| `stdin-reply` | `{ id, value }` | answers `input-request` |
| `mpl-event` | `{ figureId, event }` | mouse/zoom into webagg |
| `scene-event` | `{ idx, event }` | **reserved, not implemented in v1** (D5) |

### worker → page

| Type | Payload | Notes |
|---|---|---|
| `ready` | `{ v, pyodideVersion }` | boot finished |
| `stdout` / `stderr` | `{ id, text }` | line-batched, as today |
| `input-request` | `{ id, prompt }` | worker suspends until answered |
| `figure` | `{ id, figureId, kind: 'diff'\|'png', data }` | webagg diff or PNG fallback |
| `done` | `{ id }` | run finished normally |
| `error` | `{ id, traceback }` | raw traceback string; page formats it |
| `scene-ops` | `{ ops: [...] }` | **reserved, not implemented in v1** (D5) |

Reserved types are defined but never sent in v1. A v1 worker that receives `scene-event` replies `error` with "not supported in this runtime version" rather than failing silently.

---

## 5. Stop

For worker-routed programs, Stop is `worker.terminate()` — immediate, unconditional, and correct for `while True: pass`. The page then:

1. marks the in-flight run cancelled and writes `[stopped]` to the console,
2. hides the Stop button,
3. spawns a replacement worker **lazily** — on next Run, or during idle after a short delay, so a student who stops and immediately re-runs doesn't wait for a cold Pyodide boot.

Cooperative cancellation (`SLEEP_CANCEL_CODE`, `installRateCancellation`) remains, unchanged, for the main-thread path. The two mechanisms never both apply to one run.

**Cost:** terminating discards the Python namespace. This is correct for Run (each run already starts clean) but matters for the REPL — see [§7](#7-the-repl).

---

## 6. `input()` without SharedArrayBuffer

`_async_transform.py` already promotes enclosing functions to `async def` and propagates `await` to callers transitively; `console.input()` is already in its namespaced await set. The worker path extends this:

1. Transform rewrites `input(...)` to an awaited call.
2. Worker posts `input-request` and suspends on a promise.
3. Page prompts through jqconsole — the same widget `console.input()` uses today — and posts `stdin-reply`.
4. Worker resolves the promise; the program continues.

If the prompt is cancelled (a new Run, or Stop), the worker is terminated, so no reply is needed.

Programs where the transform cannot insert `await` never reach the worker — they were routed to the main thread ([§3](#routing-rules)).

---

## 7. The REPL

The #109 REPL moves to the worker. Each submitted statement is a `run` message against a persistent namespace held in the worker.

This removes the REPL's one documented limitation: an infinite loop typed at the prompt currently freezes the tab with no recovery but reload.

**Explicit consequence:** stopping a runaway REPL statement terminates the worker and therefore **loses the session's variables**. The page states this plainly when it happens (`[stopped — console session reset]`) rather than letting a student wonder why `x` disappeared. Preserving a namespace across termination is not possible and is not attempted.

---

## 8. matplotlib

`backend_webagg_core` is pure Python and transport-agnostic — upstream webagg carries its messages over a WebSocket from a Tornado server, `ipympl` carries them over a Jupyter comm. We carry them over `postMessage`:

```
worker                                   page
------                                   ----
backend_webagg_core   ──{figure diff}──▶  mpl.js → canvas
handle_json(event)    ◀──{mpl-event}───   mouse / zoom / resize
```

`mpl.js` ships with matplotlib and is **version-coupled** to it, so it is served from the Pyodide-installed matplotlib rather than vendored independently, and the versions are asserted at load.

**Fallback:** if `mpl.js` fails to load or the webagg handshake fails, the worker switches that figure to `Agg` and sends `kind: 'png'`. A plot always appears; it just loses interactivity. This keeps a broken frontend from turning into a blank output pane.

---

---

## 8a. Variable explorer and step debugger over the channel

An earlier draft routed these to the main thread. That was wrong, and it mattered:
both flags are *site* config, so the rule would have disabled worker coverage
entirely for any deploy that enabled the explorer. Reading the implementation
shows neither feature needs the main thread.

**Both are already JSON at the boundary.** `VARS_HELPER` and `RECORD_HELPER` each
end in `json.dumps(...)`, and the JS side does a single `JSON.parse` — a comment
at `pyodide.js:551` says so outright ("the JS side does a single JSON.parse and
never juggles PyProxy lifetimes"). Nothing live crosses the boundary today, so
nothing live needs to cross the channel.

**Both are needed only when Python is idle**, which is what makes this work:

| Feature | When it reads state | Payload |
|---|---|---|
| Variable explorer | **post-run only** — one call site, on success and on error | array of `{name, kind, type, value, …}` |
| Step debugger | **once, after the run** — the recorder returns the whole run | `{error, truncated, armed, skipped, output, steps, snaps}` |
| Lazy tree expansion | on click, after the run | one expanded node |

The worker's message loop is blocked *while Python runs*, exactly as the main
thread is today — but neither feature asks for anything during a run, so the
block is irrelevant. Live mid-run inspection is not a feature today and is not
added here.

### Added messages

| Direction | Type | Payload |
|---|---|---|
| page → worker | `snapshot` | `{ id }` — request the post-run namespace |
| page → worker | `record` | `{ id, source }` — run under the step recorder |
| page → worker | `expand` | `{ id, path }` — expand one tree node |
| worker → page | `snapshot-result` / `record-result` / `expand-result` | `{ id, json }` |

The worker runs the **same** `VARS_HELPER` / `RECORD_HELPER` source, unmodified.
`renderVariables()` and the replay UI on the page are unchanged — they already
consume parsed JSON and cannot tell which runtime produced it. This is the
cheapest kind of port: a transport change with no logic change on either side.

### The one real behavioural difference

Stopping a worker program **terminates it**, so there is no post-run snapshot —
the Variables panel has nothing to show, and an already-rendered tree can no
longer expand, because the namespace it described is gone.

Today, stopping a program raises inside Python, the run completes as an error,
and the post-run snapshot still happens. So this is a genuine regression in one
narrow case, and it is the direct price of unconditional Stop. The page marks the
panel stale ("variables unavailable — the program was stopped") rather than
showing a silently empty or stale-but-unlabelled table.


## 9. Errors, tracebacks, and output

The worker sends the **raw** traceback string. All formatting stays on the page, reusing what already exists:

- `formatPythonTraceback(msg, mainName)` — strips Pyodide-internal frames (#107)
- `escapeConsoleHtml(text)` — prevents angle-bracketed names being eaten by the HTML parser, and prevents markup in an exception message from executing

The worker's frames differ from the in-window ones (no `pyodide.asm`, different paths), so `TRACEBACK_INTERNAL` is verified against real worker tracebacks and extended if needed — with a test per added pattern.

---

## 10. Non-goals, and what comes next

**Not in this project:**

- Replacing the VPython bridge. Today's `from js import …` bridge stays. Interactive 3D in the worker is the committed destination (D5), but it needs the vpython-jupyter-style protocol — proxy objects, compact per-attribute diffs keyed by object index, a browser-driven flush, and shadow state for reads (`obj._value = evt['value']`) — and that is a spec of its own. This design only guarantees the channel won't need rebuilding for it.
- Turtle graphics, `micropip`, and other DOM-touching packages — routed to the main thread by the same mechanism if they prove to need it.

**Why 3D is tractable later, recorded so it isn't re-argued:** GlowScript renders WebGL in the browser and owns camera interaction, so dragging a scene stays smooth *even while Python computes* — better than today, where a busy program freezes the scene. Only program-driven changes and bound handlers need a round trip, and `postMessage` is cheaper than the localhost WebSocket vpython-jupyter already ships interactively.

---

## 11. Testing

| Layer | What | How |
|---|---|---|
| `chooseRuntime()` | every routing rule, including precedence | node unit tests, no browser |
| Stop | `while True: pass` is killed; page stays responsive | Playwright, `test/browser/specs/` |
| `input()` | prompt round-trip; cancel mid-prompt | Playwright |
| matplotlib | figure renders; interaction works; PNG fallback | Playwright |
| REPL | statements persist; runaway stops with a clear reset message | Playwright |
| Regression | VPython, variable explorer, step debugger unchanged | existing specs, must stay green |

The routing predicate is the only cheaply-testable piece, which is exactly why it is a separate pure module. Everything else is genuine runtime behaviour and is tested in a browser against a live stack — consistent with how #107/#108/#109 were verified.

---

## 12. Rollout

1. Behind `?runtime=worker` and `config.features.workerRuntime` (default **false**).
2. Enabled on the trial servers; exercised against the manual smoke checklist.
3. Default flipped only after the trials are clean, and only for non-VPython programs.
4. `?runtime=main` remains permanently as an escape hatch.

**Success criteria:**

- `while True: pass` is stoppable, and the page stays responsive while it runs.
- No change in behaviour for VPython programs.
- `input()`, matplotlib, and the REPL work in the worker.
- Cold-start cost after Stop is not visible to a student who immediately re-runs.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Pyodide boot cost on every Stop | pre-warm a replacement worker during idle |
| `mpl.js` / matplotlib version skew | serve `mpl.js` from the installed matplotlib; assert versions; PNG fallback |
| Routing misfires — a program silently loses freeze protection | `chooseRuntime()` returns a `reason`, surfaced in `/version`-style diagnostics and asserted in tests |
| Two runtimes drift apart | shared output formatting; regression specs run against both |
| Worker adds latency to short programs | measure; if material, keep short programs on the main thread by the same routing mechanism |
