# Stop button for Web VPython (GlowScript) trinkets

Status: design approved 2026-10-09 by Todd Zimmerman in a brainstorming session.
Branch `stop-button`, cut from `main` at `486a659`. Line anchors below refer to that commit.
Implementation plan: `docs/superpowers/plans/2026-10-09-glowscript-stop-button.md`.

## Problem

A Web VPython trinket (the `glowscript` trinket type, not Python trinkets that
import vpython) has no way to stop a running program. Pressing Run rebuilds the
program's sandboxed iframe, so the only way to halt `while True: rate(100)` is to
run it again or leave the page. The page also never learns when a program
finishes, so it cannot show whether anything is still running.

Wanted behaviour, in the requester's words: once a user hits Run, the button
changes to a stop sign; when the code finishes it changes back to Run; hitting
Stop while code is running interrupts it and the button turns back to Run; while
code is actively running the Stop button shows a subtle animation.

## Decisions

| Question | Decision | Rejected |
|---|---|---|
| Which trinket types | GlowScript Web VPython only. Pyodide is left alone and may be revisited later to match this look. | Python only; Python plus GlowScript; all browser runtimes |
| What Stop leaves on screen | Freeze in place: the 3D scene, graphs, captions and printed output stay, and the camera can still be rotated and zoomed. | Clear the output; still image of the last frame |
| Running animation | One short strip laps the inside edge of the button, one lap every 1.6 s. | Orbiting ring around the icon (disliked); twin strips; long slow strip; breathing tint; sliding bottom strip; pulsing icon |
| Implementation | A: a pause shim injected into the runner page, with a guaranteed teardown fallback. | B: a stop API inside rsWVPRunner (needs a runtime rebuild, covers 3.2.3 only); C: teardown only (contradicts freeze in place) |
| Stop icon | Font Awesome `fa-stop` (square), as trinket's existing Stop controls use. An octagon was previewed and is not chosen. | Octagon |

## What exists today

- The editor toolbar's Run control is `<a class="run-it menu-button item allow-original" data-action="code.run" data-tooltip ...>` with `fa-play` and a `Run` label (`lib/views/embed/glowscript.html:19`). Output-only embeds use the shared `lib/views/embed/default-toolbar.html:1`, whose `.run-it` is a `<button>`; that file also holds a hidden `.stop-it` that only the Pyodide runner reveals.
- `public/js/embed/embed.js:270` turns a click or Enter on any `.menu-button` into the jQuery event `trinket.<data-action>`. Ctrl/Cmd-Enter in the editor fires `trinket.code.run` directly (`glowscript.js:363`).
- `trinket.code.run` calls `showResult()` and then `runCode()` (`glowscript.js:379`, `:148`). `runCode()` fills the client-side template `#glowscriptTemplate` (`glowscript.html:154`) and loads it into a fresh `sandbox="allow-scripts ..."` srcdoc iframe `#glowscriptOutput` (`runCodeLocal`, `glowscript.js:112`) or posts it to an external sandbox server first (`runCodeExternal`, `:131`).
- The runner page loads the GlowScript runtime (`glow`, `RSrun`, `RScompiler` for the requested version) in `<head>`, then compiles the program and runs it. For 2.9 and later it runs `eval(program); await __main__()` inside `runProgram()` (`glowscript.html:238-241`). For 1.1 to 2.7 it calls `window.userMain(callback)` (`:290`).
- The runner talks to the page only by `postMessage` with JSON strings: `glowscript.loadfail` (a runtime file failed; the page rebuilds with backoff, `glowscript.js:85-108`), `glowscript.error` (compile or runtime error; the page shows an alert banner, `:468-483`), and `snapshot` (thumbnail capture). The page sends the plain string `glowscript.snapshot`. There is no finished message and no notion of a running program.

## Design

### Units

1. **Runner shim**, `public/js/embed/glowscript-stop-shim.js`. A single self-contained function `install(win)` that references nothing outside itself, exported UMD-lite like `runner-retry.js`. `glowscript.js` injects its source text into the runner template through a new `{{stopShim}}` placeholder placed at the top of the runner's body script, after the runtime has loaded and before the program is compiled. It:
   - posts `glowscript.ready`;
   - wraps the wait functions `win.rate`, `win.sleep`, `win.waitfor`, `win.pause`, and `win.canvas.prototype.waitfor` and `.pause`, each only if it exists and is a function, and only once;
   - listens for the `glowscript.stop` message;
   - while no stop is requested, every wrapper is a pass-through;
   - after a stop request, a wait that is in progress never hands control back to the program, a new call never starts (except while a snapshot of the stopped program is being taken; see Edge cases), and the runner posts `glowscript.stopped` once.

   Both GlowScript calling styles are handled: a promise result (2.9 and later) and a continuation callback as the last argument (1.1 to 2.7). If a stop arrives while at least one wrapped wait is pending, the confirmation is immediate; otherwise it is sent when the program next calls a wrapped function.
2. **Runner template change** in `glowscript.html`. Insert `{{stopShim}}`, and post `glowscript.done` when the program finishes normally: after `await __main__()` returns, and in the `userMain` callback when there is no error. Error paths are unchanged, except that on 2.9 and later `window.onerror` tags an error raised while the main flow runs (see the message protocol).
3. **Run-state controller**, `public/js/embed/glowscript-run-state.js`. Pure, UMD-lite, no DOM and no clock of its own: the page passes in timer functions and callbacks (`onState`, `requestStop`, `teardown`). It owns the states, the 2 s stop window, and a generation number.
4. **Run/Stop button view**, `public/js/embed/run-stop-button.js`. Given the `.run-it` elements on the page, it records each one's original action, title, aria-label, icon class and label text, and applies the three visual states. Returning to idle restores the recorded originals exactly, so both toolbars keep their own wording. Styles live in a new `static/scss/embed/_run_stop.scss`, imported by `embed.scss`; every rule is scoped to state classes that only this view adds, so other runtimes are unaffected.

`glowscript.js` wires them together and owns the DOM: it builds the controller and the view, injects the shim source, routes messages, handles `trinket.code.stop`, and guards asynchronous rebuilds with the generation number.

### Message protocol

| Direction | Message | Meaning |
|---|---|---|
| runner to page | `{"glowscript.ready": true}` | The runner's body script has started; the program is about to compile and run. A runner that already reported a load failure is ignored, so its ready never counts |
| runner to page | `{"glowscript.done": true}` | Program finished normally (new) |
| runner to page | `{"glowscript.stopped": true}` | Program parked after a stop request (new) |
| runner to page | `{"glowscript.error": ..., "type": ...}` | Existing; treated as the end of the run, unless it carries `glowscript.background` |
| runner to page | `{"glowscript.error": ..., "type": "runtime", "glowscript.background": true}` | An error `window.onerror` caught while the program's main flow runs, on 2.9 and later: raised outside that flow (an event handler, a timer), so it does not end the run (new field) |
| runner to page | `{"glowscript.loadfail": src}` | Existing; drives the rebuild policy |
| page to runner | `"glowscript.stop"` | Park the program now (new; same plain-string style as `glowscript.snapshot`) |

The page passes runner messages to the controller only when `event.source` is the current `#glowscriptOutput` window, so a late message from an earlier run cannot change the button. The existing error banner keeps its current behaviour.

### Run-state controller

States are `idle`, `running` and `stopping`. The generation number increases on every launch and every teardown.

| From | Event | To | Effect |
|---|---|---|---|
| any | `launched` (a new run began) | running | New generation; cancel any stop timer; runner not yet ready |
| running | `ready` | running | Runner marked ready |
| running or stopping | `done`, or an `error` without `glowscript.background` | idle | Cancel stop timer |
| running or stopping | `error` tagged `glowscript.background` | unchanged | Ignored: the program's main flow is still running |
| running or stopping | `loadFailed` (retry budget exhausted) | idle | Cancel stop timer |
| running, within 500 ms of `launched` | `stop` | running | Ignored: the second click of a double-click on Run (added during planning) |
| running, runner ready | `stop` | stopping | `requestStop()`; start the 2000 ms stop timer |
| running, runner not ready | `stop` | idle | `teardown()`; new generation |
| stopping | `stopped` | idle | Cancel stop timer; scene stays frozen |
| stopping | stop timer fires | idle | `teardown()`; new generation |
| stopping or idle | `stop` | unchanged | Ignored |
| idle | `ready`, `done`, `stopped`, `error` | idle | Ignored by the controller (the error banner still shows) |

`teardown()` empties `#glowscriptIframeContainer`, hides `#loadingContent`, and shows a one-line note in the output area: "Program stopped. Press Run to start it again."

### Button states and visuals

| State | Icon | Label | `data-action` | aria-label | Look |
|---|---|---|---|---|---|
| idle | original (`fa-play`) | original (`Run`) | original (`code.run`) | original | Unchanged from today |
| running | `fa-stop` | `Stop` | `code.stop` | `Stop program` | Icon and label red `#C62828` (5.6:1 on white); one strip laps the inside edge |
| stopping | `fa-stop` | `Stopping…` | `code.stop` | `Stopping program` | Icon and label gray `#6B6B6B`; strip paused at half opacity; no hover fill; `aria-disabled="true"` |

- The strip is an `aria-hidden` SVG injected once into the control: inset 3px from each edge, a `rect` with `width="100%" height="100%" rx="3" pathLength="100"`, stroke 2px in `currentColor`, `stroke-dasharray: 24 76`, animated by `stroke-dashoffset` from 0 to -100 over 1.6 s, linear, infinite.
- Hover and keyboard focus while running fill the control with `#C62828` and turn the icon, label and strip white; focus also shows a visible 2px ring.
- `prefers-reduced-motion: reduce` replaces the moving strip with a static 1.5px outline in the same color.
- On entering running, the control's minimum width is set to its width with its widest label (Run, Stop or Stopping…) until it returns to idle, so the toolbar does not shift as the label changes.
- The title follows the state: "Stop the program." while running and "Stopping the program." while stopping. The editor toolbar's control has a Foundation tooltip, which this project's Foundation 5.5 builds once at page init from the title, blanking the title as it does, and never rebuilds; for such a control the view rewrites the tooltip's text in place and leaves the title as Foundation left it. A control without a tooltip carries the wording in its title attribute.
- Clicks in stopping are ignored by the controller.

### Wiring in glowscript.js

- `runCode()` calls `launched()` right before it hands the runner HTML to `runCodeLocal` or `runCodeExternal`, after every early return, such as an invalid version, has passed.
- `runCodeExternal` records the generation before its POST and inserts the iframe only if the generation is unchanged when the reply arrives.
- A load-failure rebuild records the generation when it is scheduled and is skipped if the generation has changed. When a retry is scheduled, later messages from that failing runner, such as its follow-on compile error, are not passed to the controller. When the policy reports the budget exhausted, the page calls `loadFailed()`.
- `trinket.code.stop` calls `stop()`. `requestStop()` posts `glowscript.stop` to the current runner window.

## Edge cases

- A double-click on Run: the second click lands on the new Stop within 500 ms of the launch and is ignored, so the program keeps running.
- Stop while the runtime is still loading, before `glowscript.ready`: immediate teardown.
- A program that finishes on its own, including a static scene with no loop: back to Run when `glowscript.done` arrives; the scene stays interactive exactly as today.
- Compile or runtime error: the existing alert banner, and back to Run.
- An error raised outside the main flow while the program runs (an event handler, a widget callback, a timer), on 2.9 and later: `window.onerror` tags its report `glowscript.background`. The existing alert banner still shows it, and the control stays Stop, because the main flow is still running.
- Enter on the output-only toolbar's `<button>` Run/Stop control: `embed.js` acts on the keypress, so `glowscript.js` cancels the click the browser would synthesize from it, and each Enter is dispatched once. Otherwise Enter on Stop before the runner is ready would tear the run down, and the synthesized click, by then on Run, would restart it.
- Ctrl/Cmd-Enter or the "Run your code first" modal while running or stopping: a fresh run replaces the old one, as today, and the button stays in Stop for the new run.
- External sandbox mode, load-failure retries and thumbnail snapshots all respect the generation guard. A frozen runner still answers `glowscript.snapshot`; after a teardown the existing snapshot code already skips a missing iframe. The runtime's screenshot goes through the waits the shim parks, so the runner template asks the shim for a window in which new waits pass through and the screenshot can finish: the window is granted only after a confirmed stop, each wait is decided when it is made, and the window closes when the screenshot settles, or after 5 s at most.
- Output-only embeds (`default-toolbar.html`) and calculator run mode behave the same as the editor view.

## Known limits

- Event handlers the program registered, such as `scene.bind` or widget `bind=` callbacks, still respond after Stop. The main program flow is halted; handlers are not.
- A program parked in an await the shim does not wrap, or computing for more than 2 s without calling a wrapped function, gets the teardown and the note instead of a freeze.
- A loop with no `rate()` or `sleep()` can freeze the browser tab before Stop can be clicked, as with Python on the main thread. No button can fix that.
- Only the 3.2.3 runtime is checked in a browser during this work. The other versions rely on unit tests of both calling styles and on the teardown fallback.
- Before GlowScript 2.9, any error report ends the run, including one from an event handler: there, the main flow's own errors may surface only through `window.onerror`, so the runner cannot tell the two apart.
- A snapshot started before a stop is confirmed may not complete: one requested while the control shows Stopping…, or one still under way when Stop is pressed, parks with the program, so that save keeps no new thumbnail.
- The snapshot window exempts every wait that starts while it is open, not only the screenshot's. An event handler's flow can therefore advance while a snapshot of a stopped program is taken, for at most 5 s. In a rare case the main flow can too: when it was in an await the shim does not wrap at the moment another flow's wait confirmed the stop. It parks again at its first wait after the window closes.

## Out of scope

- The Pyodide runner, its separate `.stop-it` control, and the markup of the shared `default-toolbar.html`.
- Web VPython Blocks (`glowscript-blocks`), the Skulpt and Pygame runners, and server-side languages.
- Silencing handlers bound by the program after Stop.

## Testing and verification

1. **Spike (throwaway, kept out of the repository).** A browser harness built like the runner template loads the real 3.2.3 runtime from the `rswvprunner` GCS bucket, plus jQuery and jQuery UI, and runs the shim. It must show that:
   - the wrappers for `rate()` and `sleep()` are the functions the compiled program calls;
   - after a stop request the program makes no further progress and `glowscript.stopped` is posted;
   - the parked scene still redraws when the camera is rotated;
   - a finite program posts `glowscript.done`.

   If interception fails, work stops and the approach is revisited with the requester before anything else is built.
2. Unit tests (Vitest), named after their units:
   - `glowscript-stop-shim.test.js` covers both calling styles, pass-through, stop while parked, stop while computing, the single confirmation, idempotent install, the pending bookkeeping, and the snapshot window: granted only after a confirmed stop, decided per wait, idempotent release and the 5 s auto-release.
   - `glowscript-run-state.test.js` covers every row of the transition table, including background errors and non-object messages, and the order of drawn states on the stop paths.
   - `run-stop-button.test.js` (jsdom) covers each state's action, label, icon, aria, title, tooltip text rewrite, strip injection and width lock, and the exact restore of both toolbars' originals.
   - `glowscript-runner-template.test.js` loads the template from `glowscript.html`, fills it the way `glowscript.js` does, and runs it against a fake runtime. It checks that the shim installs before the program runs, that ready then done is posted on both version paths, that a failing shim never keeps the program from running, that a stopped program still answers a snapshot request, and that `window.onerror` tags background errors only while the 2.9+ main flow runs.
3. `npm run build:css` succeeds with the new partial.
4. `test/browser/specs/glowscript-stop.spec.js` (Playwright, local stack) covers:
   - Run shows Stop with the strip;
   - Stop returns to Run and the program is frozen in place, parked rather than torn down;
   - a stopped program still answers a snapshot request;
   - an error in an event handler does not end a running program;
   - a finite program returns to Run on its own;
   - a compile error returns to Run;
   - Enter on the output-only Stop button stops the program instead of restarting it.

   It needs the local stack and the vendored runtime. If that is not available during the work, it is committed unrun and marked as such.
5. The full unit suite passes.

## Order of work

Spike; shim; controller; button view and SCSS; wiring and template; Playwright spec; changelog and What's New entries. Planning and tracking use CCPM (PRD, epic and tasks under `.claude/`, which git ignores) and the Superpowers implementation plan named above.
