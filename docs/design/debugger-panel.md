# Floating DEBUG panel — scoping for Wish 3

Status: **scoping. Nothing implemented, nothing decided.** Follow-up to
`pyodide-debugger-mvp.md`, whose Phases 1-3 are in `main` behind
`features.stepDebugger`.

The ask (Larry, 2026-09-08): take the step-through debugger out of the
Variables tab and give it its own floating affordance in the editor's file-tab
bar — the word `DEBUG` in small caps over a bug icon, a drag grip on its left,
expanding rightward into the empty part of that bar, styled like the plotpolish
panel. It should appear after the first Run of any program with at least two
non-import lines. The point is not decoration: it is being able to step and
watch the **Result** pane change — VPython scenes building, and matplotlib
plots redrawn once per loop iteration with only the newest one shown.

## 1. What exists today (verified, with refs)

- The debugger is **record & replay**, not live stepping, and for a hard
  reason: Pyodide runs on the browser main thread, so blocking Python at a
  breakpoint freezes the debugger's own UI. `sys.settrace` records a JSON
  trace, replay is pure UI over that trace. See `pyodide-debugger-mvp.md`
  "Why record & replay".
- Recorder + replay live in `public/js/embed/pyodide.js:1712-2290`
  (`RECORD_HELPER`, `runStepThrough`, `debugStepTo`, `paintReplaySnap`,
  `exitReplay`). Caps: 5 000 steps, 50 vars/step, 120-char reprs, **2 MB total
  JSON** (`DEBUG_MAX_BYTES`), 200 000 dormant line events.
- Markup is nested **inside** `#variables-wrap` in
  `lib/views/embed/pyodide.html:439-478`, which is why
  `features.stepDebugger` requires `features.variableExplorer`.
- There are already **two** entry points, and the second one exists for exactly
  the reason Larry gives: `#debug-start-alt`
  (`lib/views/embed/pyodide.html:435`) is an icon dropped into `#console-wrap`
  because "the launcher itself lives in the Variables panel, which a student
  has to know to open first". So discoverability is a known, already-patched-at
  problem — this proposal replaces the patch rather than inventing the concern.
- Breakpoints exist (Ace gutter, `debugBreakpoints`, next/prev navigation, plus
  deferred recording that arms the tracer at the first breakpoint).
- **VPython is refused**, but only after the click:
  `pyodide.js:2219` shows "Step through is not available for VPython programs".
- matplotlib in a debug run: figures appear at the **end**, as in a normal run.
  Plot state is not stepped at all.

## 2. Question 1 — how much harder is it outside the Variables tab, and draggable?

Short answer: **the panel chrome is cheap; the variables table is the
expensive part.** Split the work and the first slice is small.

### 2a. The tab bar cannot host it. Use an overlay layer instead.

`static/scss/embed/_code_editor.scss:332` gives `.tab-nav`
`height: 2.275rem; overflow: hidden`. A child of that bar can be neither
taller than ~36 px nor dragged out of it, and the `overflow: hidden` is load-
bearing (it clips the horizontally scrolling file-tab strip).

So: render the pill in a **position-absolute overlay layer over the whole
embed**, with its *default* coordinates computed to land in the gap between
`dl.scrollable-content` and `dl.right-options` — visually docked in the bar,
structurally not in it. Zero change to Trinket's layout, and the expanded
panel can then be any size and can be dragged anywhere.

This is not speculative: **plotpolish already ships exactly this widget.**
`plotpolish/src/panel.css` has `.pill.float` (fixed layer, 999px radius, drag
shadow), `.pill .grip`, `.pill.collapsed` (grip only, tucked into a corner),
`.popover` with a `.pop-head` grip and a caret, and `.pill.dragging`
(transition suppressed so it tracks the pointer). Same author, same repo,
BSD-3. The requested aesthetic is a variant of a component we have.

### 2b. The real coupling is `#variables-table`, not the markup

Replay does not own a view of its own — it **paints the explorer's table**:

- `paintReplaySnap(...)` at `pyodide.js:2097` writes the recorded snapshot into
  `#variables-table`;
- `renderVariables()` bails out while replay is live — `if (debugRec) return;`
  at `pyodide.js:2380`, commented "replay owns the table";
- the "changed since last step" diff highlighting is CSS on that table
  (`.var-changed`, `pyodide.html:284-288`);
- and the "`inside f() — called from line N`" breadcrumb, the callables filter,
  the per-row copy buttons and the "expansion disabled in replay" rule all
  belong to that table.

Hence two variants, and they are very different sizes:

| Variant | What moves | Cost |
|---|---|---|
| **A. Controls float, variables stay** | pill + step controls + slider + breakpoint jumps + note go to the overlay; the Variables tab keeps rendering snapshots exactly as now | **~1-1.5 d** |
| **B. Panel owns its own variables view** | plus a compact variables list inside the panel: diff highlighting, breadcrumb, callables filter, truncation notes | **+1.5-2 d** |

**Recommendation: ship A first.** It delivers the whole discoverability win and
the whole "step while watching the Result pane" win, because in A the student
is *no longer forced into the Variables tab at all* — the Result tab can stay
open while they step. B is a nice-to-have that removes the last reason to visit
the tab, and it is the slice that would finally let `features.stepDebugger`
stand without `features.variableExplorer`.

### 2c. Three things that do get harder, and are easy to miss

1. **Arrow keys.** `pyodide.js:3659-3666` binds ←/→ (and Shift+← /→) at
   document level, guarded only by `debugRec` being non-null. Today that is
   safe because you are looking at a table. A panel floating over Ace means
   arrow keys have to be adjudicated: panel focused ⇒ step, editor focused ⇒
   move the caret. Needs an explicit focus rule, ~0.25 d, and it is the kind of
   bug that gets found by a student, not by us.
2. **Occlusion.** The pill sits over the file-tab strip and the expanded panel
   over Ace. Needs a z-index budget and a collapsed "tuck away" state —
   plotpolish's `.pill.collapsed` is that state, already written.
3. **Two panels, one corner.** If `features.plotStyle` and this are both on,
   plotpolish's floating pill and this pill are both draggable overlays in the
   same embed. Decide now whether they share one layer and one drag
   implementation (preferable) or coexist as strangers.

### 2d. The trigger rule

"Appears on first Run if there are ≥2 non-import lines" is cheap:
`editor.getAllFiles()[mainFile]`, drop blank/comment/`import`/`from … import`
lines, count what is left. Edge cases to get right: parenthesized multi-line
imports, module docstrings, `from __future__`. An hour or two. If exactness
matters, the ast-based `_async_transform.py` is already fetched into the
Pyodide FS and could answer it properly — but a regex heuristic is fine for
deciding whether an affordance appears.

Two rules to fold in at the same time:

- **Do not show the pill for VPython programs.** `usesVPython()` already
  exists (`pyodide.js:1040`); refusing before the click beats the current
  refuse-after-the-click note at `:2219`.
- **A wart to resolve deliberately.** An affordance that appears *because you
  just ran* implies it will step *that run*. It will not: `runStepThrough()`
  performs a fresh instrumented run in a **fresh namespace**, while normal Run
  execs in the persistent `pyodide.globals`. So a program that Run-succeeded on
  leftover state can `NameError` under Step through. The existing tooltip says
  so; a pill with two words on it cannot. Suggested panel wording: *"Re-runs
  your program from scratch, slowly, to record it."*

## 3. Question 2 — could this work with matplotlib?

**Not today, and the reason is structural, not a missing wire:** replay never
executes anything. It scrubs a JSON array. There is no live figure behind step
*k* to look at.

**But it can, and the mechanism is small.** Capture a figure frame *during the
recording run*, from inside the tracer:

```
if plt.get_fignums():
    fig = plt.gcf()
    if fig.stale:                      # matplotlib's own dirty flag
        fig.canvas.draw()
        buf = io.BytesIO(); fig.savefig(buf, format='png', dpi=72)
        frames[step] = base64(buf)
```

Pure Python, no DOM, so it works identically on the main thread and in the
worker. Replay then shows, in `#graphic`, the newest frame at or before step
*k* — which **is** the requested "plot in a loop, show only the most recent
one", and stepping backwards walks the plot backwards, which no live debugger
can do.

The whole feature is **capture policy and budget**:

- **Size.** `DEBUG_MAX_BYTES` is 2 MB for the entire JSON payload; a 400×300
  PNG is 10-30 KB, so frames need their own budget and their own channel.
  Either a separate result key with its own cap (~8 MB), or — better — write
  frames into the Pyodide FS during recording and `FS.readFile` them lazily as
  the student steps. The #253 file-outputs work already established FS read
  plumbing on both runtimes, so the lazy route is mostly assembled.
- **Time.** `draw()` + `savefig` is roughly 10-40 ms. Doing it at 5 000 steps
  is 50-200 s — unacceptable. So: capture only when `fig.stale`, cap the frame
  count (~200), and subsample once the cap is hit. For the target program (a
  loop that plots once per iteration) that is tens of frames and tens of
  milliseconds each.
- **Multiple figures.** Decide whether the panel shows `gcf()` only or all
  open figures. Note the known bug that the **worker never closes figures
  between runs** (no `plt.close('all')` in `pyodide-worker.js` MPL_SETUP, while
  the main thread does at `pyodide.js:44`) — figures accumulate across a
  session, so "all open figures" means something different on each runtime.

Estimate: **1.5-2.5 d** on top of the panel work. It should follow wish-list
item **01 (runtime contract spec, 1 d)**, because the two matplotlib
integrations already differ in figure lifecycle, resize plumbing and save path,
and this adds a third divergence point.

Bonus: the same capture mechanism is what "plots in a loop" needs *outside*
the debugger, and it composes with item 06 (plot DPI + Save plot).

### VPython is a different feature, not an extension of this one

Good news first: the async transform **never adds or removes lines**
(`pyodide.js:1303-1305`), so `settrace` line numbers would still map to the
lines the student wrote. That objection is dead.

What actually blocks it: the scene is a live WebGL canvas mutated in place (not
re-rendered from a scene description we can snapshot cheaply), the program is
`while True: rate(30)` so one second of animation is thousands of line events,
and the run is async — every `await rate()` yields to the browser mid-trace.

The right product here is **not a line debugger but a frame scrubber**: treat
each `rate()`/`sleep()` yield as one step, capture `canvas.toDataURL()` at each
yield, and drive it from the same panel with the same slider. Unknowns are
real (WebGL `preserveDrawingBuffer`, per-frame memory, how the glowscript
bridge exposes the canvas). Call it **a separate 2-4 d spike**, listed apart so
it is never confused with the matplotlib slice — and note it is the slice Larry
is most excited about, so it deserves its own prototype before its own
estimate.

## 4. Question 3 — the minimally invasive prototype

Goal: show collaborators the aesthetics and the interaction without touching a
file that item 02/04/07 work is also editing. **Zero repo diff, two pieces:**

1. **A standalone HTML prototype, published as an Artifact.** Fake the embed
   chrome from Larry's screenshot (toolbar row with Run and Clear memory, the
   file-tab bar with `main.py`, a static code pane with a highlighted current
   line, a Result pane). Make the *panel* real: DEBUG-over-bug-icon collapsed
   pill, grip drag, expand rightward, step slider, breakpoint jumps, and a
   canned 40-step recording of a loop that plots — so the plot in the Result
   pane really does advance as you scrub. Styles lifted from
   `plotpolish/src/panel.css` so the family resemblance is literal, not
   described. Collaborators get a link and click it.
2. **One in-situ screenshot or GIF.** The same panel injected into the running
   local embed from a devtools snippet — still zero diff, but the shot shows
   the real toolbar, real Ace, real figure, which is what actually convinces
   people it fits. The embed page is directly reachable
   (`window.TrinketAPI`, `document.querySelector('a.run-it').click()`), so this
   is minutes, not hours.

Then, if the shape is agreed, the real thing lands in the shape
`plotpolish-adapter.js` already established and proved reviewable: **one new
plugin file** (`public/js/plugins/debug-panel.js`), **one feature flag**
(`features.debugPanel`, default `false`), and **two or three small hooks** in
`pyodide.js` handing over the closure-local `api`/`editor`/`debugRec`. Nothing
else in the tree moves, so the diff a collaborator reads is one file plus a
flag.

## 5. Suggested order

| # | Slice | Est. | Notes |
|---|---|---|---|
| 0 | Prototype (artifact + in-situ shot) | 0.5-1 d | zero repo diff |
| 1 | Panel shell, variant A (controls float, variables stay) | 1-1.5 d | one plugin file + flag + hooks |
| 2 | Trigger heuristic; no pill for VPython | 0.25 d | |
| 3 | Focus / arrow-key adjudication | 0.25 d | |
| 4 | matplotlib frame capture + replay in `#graphic` | 1.5-2.5 d | after wish item 01 |
| 5 | Variant B: panel owns its variables view | 1.5-2 d | optional; frees the `variableExplorer` dependency |
| 6 | VPython frame scrubber | 2-4 d | separate spike, own prototype first |

Slices 0-4 — the visible win, stepping while watching a plot redraw — are
**~4-6 engineer-days**. That is meaningfully more than the 2 d that wish item
03 currently carries in the ledger; the ledger figure was for the debugger as
built, not for this.

## 6. Open questions for Larry

1. Variant A now and B later, or hold out for B?
2. Should the pill *replace* both existing entry points (`#debug-start` in the
   Variables toolbar and `#debug-start-alt` in the console), or sit alongside
   them during a transition?
3. Does the panel remember where it was dragged to — per session, or per
   trinket? plotpolish's popover "stays put across tab switches once dragged"
   but does not persist across reloads.
4. On the fresh-namespace wart: is re-running on Step-through acceptable, or
   should the pill only appear when the program is namespace-clean?
5. matplotlib frames: `gcf()` only, or every open figure?

## 7. Calibration against plotpolish (the one estimate we can now audit)

Wish item **07 "style panel"** was sized at **2.5-3 engineer-days**. It is the
only wish that has been built end to end, so it is the only place the ledger
can be checked against reality. Measured 2026-09-08:

| | Estimated | Delivered |
|---|---|---|
| Scope | "rcParams style panel" | standalone BSD-3 repo, web component, single-file Python core, host adapter |
| Source | — | ~6 900 lines (`src/`, `python/`, excluding tests) |
| Tests | — | ~9 600 lines |
| Docs | — | ~1 800 lines across 6 files (plus a demo GIF) |
| Trinket side | — | 356-line adapter + 3 hooks in `pyodide.js` |
| History | — | 75 commits over 3 calendar days; 4 releases to v0.3.2 |
| PRs | — | ~6 in plotpolish, 3 in Trinket (#251, #256, #261) |
| Reaching a student | implied | **not yet** — `features.plotStyle` is `false` in `config/default.yaml`, not overridden in production, and #261 is in someone else's merge queue |

Calendar days here are agent-assisted and are **not** the same currency as
engineer-days, so the honest comparison is scope-to-scope, not time-to-time.
On scope, the overrun is large. Where it came from, and whether it repeats:

**Would not repeat (one-time costs, already paid):** new repo, CI, a release
pipeline that gates four version strings, the IIFE build, the Python packaging
— none of that applies to a Trinket plugin file. And the floating pill with a
grip, a collapsed state and drag was **designed three times** (flat panel:
"overwhelming"; strip under the figure: "breadcrumbs suck"; floating pill:
kept). Two of those rounds were thrown away. That component now exists.

**Would repeat:**

1. **UX rounds on the part that is not specified.** Larry's screenshot pins
   the collapsed pill and where it lives — far more specification than the
   plotpolish brief started with. It says nothing about what the *expanded*
   panel contains, and that is precisely where plotpolish's discarded rounds
   were spent.
2. **Review passes.** The plotpolish work ran multiple Copilot passes per PR
   and accumulated 48 unresolved threads at its peak.
3. **The two-runtime tax.** The adapter's `hostRcKeys` had to become
   runtime-conditional because main thread and worker set different rc keys.
   Figure capture (slice 4) hits the same fork harder: figure lifecycle, the
   save path and the worker's missing `plt.close('all')` all differ.
4. **Merge latency**, which is not engineering time at all but is what
   "delivered" waits on.

**Restated estimate.** 4-6 d is a fair figure for slices 0-4 *as specified*.
Against this precedent, "in front of a student" is realistically **8-12 d**,
and the multiplier sits almost entirely in items 1-4 above rather than in the
code scoped in section 5. Note also that the ledger's own line for this work,
**"03 debugger UX (2 d)"**, is what 4-6 d is replacing — so the estimate has
already grown 2-3x on inspection, before any of the plotpolish-style overrun.

## 8. Larry's own time, as a ratio to plotpolish

Asked 2026-09-08: not engineer-days, but **how much of Larry's time** this
costs relative to plotpolish. A judgment call, not a measurement.

Headline: **~0.5-0.7x of plotpolish for slices 0-4.** Including the VPython
frame scrubber (slice 6), **~1.0-1.3x.**

His time on plotpolish broke down as design judgment, hands-on verification,
and process (review clicks, releases, merge chasing). Those three move in
different directions here:

| Category | vs plotpolish | Why |
|---|---|---|
| Design / UX judgment | **~0.3-0.5x** | The pill, grip, collapsed state and drag were designed three times and two were thrown away. That component now exists and he has already approved it; the screenshot settles the collapsed state. What is left unspecified is the expanded panel's contents — one or two rounds, not three. |
| Hands-on verification | **~1.5-2x** | The higher figure, and the important one. plotpolish's claim ("the style applies") is checkable by tests plus a glance. This feature's claim — "step and watch the plot redraw" — is a *feel* claim: stepping latency, whether a captured frame lags the highlighted line, whether the pill fights Ace's arrow keys, and whether the `fig.stale` capture policy picks the right frames **for his actual teaching programs**. None of that is reachable by tests or by an agent; it needs him running real classroom code and reacting. |
| Process | **~0.2-0.4x** | No new repo, no release pipeline, no version gates, no packaging. One or two PRs against ~9, so far fewer Copilot passes to click through, and no release decisions. |
| Pedagogical calls | new, unavoidable | What a student should see at step *k*; whether the fresh-namespace re-run is acceptable; one figure or all. His expertise, not delegable. |

**Why VPython flips it.** Slice 6 is a spike whose value can only be judged by
eye — nobody can tell from a diff whether scrubbing a 3D scene teaches
anything. Its verification cost alone is comparable to plotpolish's entire
design cost, which is why it should carry its own prototype and its own
decision, separately from slices 0-4.

**The lever.** Verification is now the dominant term in his time, so the way
to cut it is to make the prototype (slice 0) run on **his own teaching
programs**, not on invented demo code. A canned recording of a plotting loop
he actually assigns settles the capture policy and the feel question before any
Trinket file is touched, and moves the expensive category earlier and cheaper.

**What would falsify this.** If the expanded panel takes three design rounds
like plotpolish did, the ratio goes to ~1x on slices 0-4 alone.
