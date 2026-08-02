# Inline `input()` for Pyodide (python3) trinkets — decision & proposal

_2026-08-01. A decision record to propose to the maintainers. Primary lens: **reduce
the risk of breaking other parts of the system by avoiding a fundamental change that
fights how things already work.**_

## The ask
Lori Reubenstein (Billerica Memorial HS; students on Chromebooks) reports two problems
with `input()` on our Pyodide (`python3`) trinkets:

1. **It's a separate popup** (`window.prompt`) — "the kind used in visual python."
2. **The popup appears _before_ any printed text renders**, "which makes them less
   useful" — you get a context-free dialog with the question/prompt not yet visible.

She wants `input()` to behave "like standard Python 3" — i.e. **inline in the console**,
the way trinket.io does it (verified in-browser: `https://trinket.io/python/6fa130b6d290`).
trinket.io can do this because it runs **Skulpt**, which *suspends and resumes*
execution on `input()`.

## Why we use `window.prompt` today (PR #81)
We run **Pyodide** (real CPython in WASM). CPython's `input()` is **synchronous**, and
`window.prompt` is the one primitive that gives synchronous blocking *for free* (the
browser blocks on it). Note: our Pyodide runner **already uses `jqconsole`** (a jQuery
terminal) for output — the *same* widget the Skulpt runner uses for inline input via
`jqconsole.Input()`. So the inline UI is already loaded; `window.prompt` was chosen
**only** to sidestep the synchronous-blocking problem, not for lack of a console.

## Two problems → two very different fixes

### Problem 2 (ordering) — cheap, low-risk, do now
- **Cause:** stdout is `batched` (`pyodide.js`: `py.setStdout({ batched … })`), and
  `_trinket_input` does `print(prompt, end="")` then calls `window.prompt` **synchronously**
  — so the batched output hasn't flushed to the DOM when the modal opens.
- **Fix:** flush/render the console (and write the prompt via a direct, non-batched
  console write) **before** opening the modal. A few lines in `pyodide.js`; no
  architecture change. Directly resolves the "less useful" complaint and makes the
  popup usable even if we never go inline.

### Problem 1 (popup vs inline) — the real project
One approach is ruled out (A, below). The other three build on the async source
transform we **already run in production** for WebVPython (see *Prior art*). The
recommended path is a scoped `console` module whose blast radius is confined two ways;
a no-transform variant is the minimal fallback; a global `input()` transform is
rejected as too broad.

#### Approach A — Pyodide in a Web Worker + `SharedArrayBuffer`/`Atomics.wait` — **RULED OUT**
The "textbook" way to get blocking stdin (JupyterLite does this). But:
- `SharedArrayBuffer` requires the page to be **cross-origin isolated** (`COOP:
  same-origin` + `COEP: require-corp`). A trinket **embedded as an iframe in a
  third-party site cannot be isolated** unless that embedder opts in
  (`allow="cross-origin-isolated"` + is itself isolated) — which they won't.
- The embed page also loads several **cross-origin CDN scripts** (Pyodide + glowscript
  from jsdelivr; highlight.js/sockjs/dropzone from cdnjs) that `COEP: require-corp`
  would block unless each sends CORP headers.
- **Embedding is a central use case for us.** So A would work only on the *standalone*
  page and fall back to `window.prompt` in embeds — a fundamental change that also
  doesn't deliver in the place it matters. **Rejected.**

#### Prior art — we already run this exact mechanism for WebVPython
Our WebVPython runner already does source-level async transformation **in production**:
`runVpython()` (`public/js/embed/pyodide.js`) loads `vpython._async_transform`, which
inserts `await` before the known-async primitives (`rate()`, `sleep()`, `get_library()`,
`*.waitfor()`), promotes any function that gains an `await` to `async`, and propagates
that to callers — then runs the rewritten program on `runPythonAsync` (top-level await).
The transform is **pure AST** (`import ast`, no vpython runtime dependency) and already
scopes *namespaced* calls by module alias, so `vp.rate()` is awaited while `meter.rate()`
on an unrelated object is not. The machinery below is not new — it's that same
battle-tested path, reused and tightly scoped.

#### Approach B″ — a scoped `console` module + import-gated transform — **RECOMMENDED**
Add a small `console` module to the Pyodide filesystem exposing an async `input(prompt='')`
that echoes the prompt to jqconsole, `await`s **`jqconsole.Input()`** (the inline field —
already loaded), echoes the entry, and raises `EOFError` on cancel. Students write:

```python
import console
name = console.input("Name? ")
```

The transform inserts the `await`, so the call reads like ordinary synchronous Python —
**no `await` for students to learn** (matters for Lori's HS Chromebook users). Two
independent controls keep the blast radius tiny:

1. **Namespace scoping (which *calls* become async).** Extend the transform's existing
   alias tracking to recognize `console` and treat `<console-alias>.input` as awaitable —
   mirroring the `vp.rate()` path. Only `console.input()` calls are ever awaited;
   `builtins.input()` and any `foo.input()` on another object are untouched.
2. **Import-gating (which *programs* run the transform).** Run the transform on a python3
   program **only if it imports `console`**; otherwise take today's untouched
   `runPythonAsync(prog)` path. Every program that doesn't opt in is **byte-for-byte
   unchanged.**

- **`input()` is left unchanged** (`window.prompt` + the ordering fix) → **zero regression**
  for existing trinkets.
- **Works in embeds and on all browsers** — no worker, no COOP/COEP, no JSPI; reuses
  `runPythonAsync` + jqconsole, both already loaded.
- **Directly answers Lori's question** ("some other function I can use… like standard
  Python 3"), and reads like standard Python.
- **Residual risk:** the transform's known edges (`console.input()` inside a `lambda` or
  comprehension can't be awaited) apply — but only inside opt-in programs, and they're
  rare for input() and documentable.

#### Flavor 1 — `console` module with explicit `await`, no transform — **minimal fallback**
Same `console` module, but students write `name = await console.input("Name? ")` and we
skip the transform entirely. Only code that imports *and* awaits it is affected → zero
blast radius. Cost: students write `await`. This is the safe floor if the transform work
needs more bake time; **B″ is the target.**

#### Approach B (global) — async-transform `input()` itself — **rejected as too broad**
Same transform, but make the builtin `input()` inline by running it on **every** python3
program. Fully standard `input()`, but it changes behavior for programs that never asked
and inherits the transform's edges globally. B″ delivers the same sync-looking inline
experience while confining *which calls* **and** *which programs* are affected, so global
B buys nothing extra and costs the blast radius.

#### Watch (not a basis for this decision) — WASM **JSPI**
JavaScript Promise Integration would let synchronous Python block on async JS with **no
worker, no headers, no coloring**. It's shipping in Chrome (and Lori's students are on
Chromebooks), but not yet cross-browser. Revisit in ~6–12 months.

## Decision
1. **Now — ship the ordering fix** (flush the console before `window.prompt`). Low-risk,
   surgical; makes the existing `input()` popup usable today.
2. **Ship the scoped `console` module (Approach B″) — `console.input(prompt)`.** Reads
   like standard Python (no `await` for students), inline via jqconsole, `input()`
   untouched. Blast radius confined two ways: namespace-scoped (only `console.input()` is
   awaited) and import-gated (only programs that `import console` run the transform). A
   **short spike** de-risks the transform on the python3 path (below).
   - **Fallback:** if the transform needs more bake time, ship **Flavor 1** first — the
     same module with an explicit `await console.input(...)` and no transform (zero blast
     radius) — then follow with the transform to drop the `await`.
3. **Reject global-`input()` inline (Approach B).** B″ gives the same inline experience
   while confining both which calls and which programs are affected; transforming every
   program buys nothing extra.
4. **Reject Approach A** (worker + `SharedArrayBuffer`). It breaks the embed model.

**Open question for Andrew/Todd:** module name — `console.input()` (recommended, reads
like a terminal) vs. a more explicit `async_input.input()`. `input()` itself is unchanged
either way.

### Spike for B″ (small — validates the scoped transform + module, not arbitrary code)
- Add the `console` module (async `input` → echo prompt → `await jqconsole.Input()` →
  echo entry → `EOFError` on cancel).
- Teach `transform_source` to recognize `console` aliases and treat `<alias>.input` as
  awaitable (mirror `_vpython_module_aliases`); import-gate the transform in the python3
  branch of `pyodide.js` (~line 1481).
- Verify `console.input()` at top level, nested (`int(console.input())`), multiple
  sequential prompts, inside a user `def`/loop, and EOF/cancel — and confirm
  `builtins.input()` / `foo.input()` on other objects are **not** awaited.
- Confirm **inline rendering in an embedded (cross-origin iframe) trinket** on Chrome
  (Chromebook target) and one non-Chromium browser.
- Confirm a program that never imports `console` is byte-for-byte unaffected (no transform
  runs).

## Why this satisfies "don't break things"
- **`input()` is unchanged** — the behavior every current trinket relies on is preserved;
  the ordering fix only makes it *render in the right order*.
- The inline capability is confined **two independent ways**: namespace scoping (only
  `console.input()` calls are awaited) and import-gating (only programs that opt in run
  the transform at all) — so no arbitrary program's execution model changes.
- It **reuses the exact mechanism already in production for WebVPython** (`_async_transform`
  + `runPythonAsync` + `jqconsole`), tightly scoped — **no** new architecture: no workers,
  no COOP/COEP headers, no CDN CORP dependencies, no embed-model change.
