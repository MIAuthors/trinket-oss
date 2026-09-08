/**
 * debug-panel: float the step-through debugger's controls out of the Variables
 * tab and onto a draggable pill over the embed.
 *
 * Why this exists: the recorder and replay are good, but the only way in is a
 * "Step through" button inside a tab a student has to know to open first. The
 * second entry point (#debug-start-alt, an icon in the console) was already
 * added for that reason. This replaces that patch with an affordance that is
 * visible without opening anything -- and, because the controls no longer live
 * in the Variables tab, lets the student keep the Result tab open and watch the
 * output while they step.
 *
 * Shape deliberately copies public/js/plugins/plotpolish-adapter.js: this file
 * holds everything that knows about the panel, and pyodide.js hands over the
 * few closure-locals it cannot reach (the debugger's state and its actions)
 * through init(). Gated by features.debugPanel; with the flag off this file
 * still loads but never defines window.trinketDebugPanel, so every hook in
 * pyodide.js is a no-op.
 *
 * Slice 1 of docs/design/debugger-panel.md: the panel shell only. It drives the
 * EXISTING replay functions and does not reimplement any of them, and the
 * in-tab controls are left in place -- whether the pill replaces them is an
 * open product question, not something to decide by deleting markup.
 */
(function(window, document) {
  'use strict';

  var cfg = window.trinket && window.trinket.config;
  if (!cfg || !cfg.debugPanel) return;

  var ctx     = null;   // { isAvailable, getState, actions }, handed over by pyodide.js
  var $layer  = null;
  var $pill   = null;
  var $help   = null;
  var $vars   = null;
  var $dock   = null;
  var dropped = {};     // names the student has dismissed with the red x
  var lifted  = [];     // names promoted with the green arrow, most recent first
  var mounted = false;
  var placed  = false;  // true once the student has dragged it; stop auto-placing
  var placeTries = 0;   // bounded retries while the layout is still settling
  var placeLast  = null; // last computed left/top, to detect convergence
  var expanded = false;

  // ---------------------------------------------------------------------
  // Where the layer lives, and why it is not just `position: fixed`
  // ---------------------------------------------------------------------
  //
  // The pill has to be draggable anywhere over the embed, which rules out
  // living inside .tab-nav: that is 2.275rem tall with `overflow: hidden`
  // (static/scss/embed/_code_editor.scss), and the clipping is load-bearing --
  // it clips the horizontally scrolling file-tab strip.
  //
  // An absolutely-positioned layer is also clipped anywhere under #codeOutput
  // (`overflow: hidden` in .mode-standard at medium-up) or #outputTabs. The
  // nearest ancestor that is BOTH positioned and non-clipping is
  // .trinket-wrapper (`position: relative`, static/scss/embed/_wrapper.scss).
  //
  // `position: fixed` would also escape the clip -- plotpolish does that -- but
  // .trinket-wrapper doubles as Foundation's .inner-wrap, which is TRANSFORMED
  // when the left off-canvas menu opens (.move-right). A fixed pill would stay
  // put while the whole embed slid out from under it; an absolute child of
  // .inner-wrap rides the transform, which is what we want.
  function layerHost() {
    var el = document.querySelector('.trinket-wrapper');
    return el || document.body;
  }

  // ---------------------------------------------------------------------
  // Styles, inlined
  // ---------------------------------------------------------------------
  //
  // Palette is plotpolish's, read out of its src/panel.css :host block, because
  // the two pills should look like one family: accent #0969da, accent-tint
  // #ddf0ff (the pill's own fill), border #d0d7de, muted #59636e. Hover is
  // Primer's next step down, #0550ae. The one exception is #cf222e for the
  // breakpoint jumps, which is plotpolish's danger token -- the debugger's own
  // #a94442 sits oddly against this blue.
  //
  // Trinket has no dark mode and no CSS custom properties, so these are literal
  // light values on purpose.
  //
  // z-index 1200 is a chosen number, not a large one: it has to clear
  // .alert-box (999) and .tab-options.open (1000), and it must stay well under
  // plotpolish's pill (2147483000, inside a shadow root) so that when both
  // features are on the plot-style pill still wins its own corner.
  var CSS = [
    '.tk-dbg-layer{position:absolute;inset:0;pointer-events:none;z-index:1200}',
    '.tk-dbg,.tk-dbg *{box-sizing:border-box}',
    // Foundation 5 ships `button { margin-bottom: 1.25rem }`, which lands on
    // every control in here and shoves each flex child 20px off the pill's
    // midline. Reset it, or nothing inside will ever centre.
    // Foundation 5 ships `button { margin-bottom: 1.25rem }` plus background
    // colours on button, button:hover and button:focus. `button:hover` (0,1,1)
    // outranks a plain class rule (0,1,0), which is why the grip kept its blue
    // wash however many times its own background was set to none. Blanket it,
    // once, for every control in here and any added later.
    '.tk-dbg button,.tk-dbg input,.tk-dbg-vars button{margin:0}',
    '.tk-dbg button,.tk-dbg button:hover,.tk-dbg button:focus,.tk-dbg button:active,',
      '.tk-dbg-vars button,.tk-dbg-vars button:hover,.tk-dbg-vars button:focus',
      '{background:none!important;background-color:transparent!important;box-shadow:none}',
    '.tk-dbg-dock{position:absolute;pointer-events:none;display:inline-block;max-width:calc(100% - 12px)}',
    '.tk-dbg-dock > *{pointer-events:auto}',
    '.tk-dbg{position:relative;display:flex;align-items:center;pointer-events:auto;',
      'background:#ffffff;border:0;border-radius:999px;',
      // The "outline" is the shadow's own hairline ring, not a border: a 1px
      // border plus a shadow reads as two edges at this radius.
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 3px 12px rgba(31,35,40,.18);',
      'width:72px;height:32px;overflow:hidden;font-size:13px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'user-select:none;-webkit-user-select:none;',
      'transition:width 170ms cubic-bezier(.2,.7,.3,1),height 170ms cubic-bezier(.2,.7,.3,1),box-shadow 140ms ease}',
    // Only the two axes change on open; the ring must survive both states.
    '.tk-dbg.open{width:352px;height:92px}',
    '.tk-dbg.dragging{box-shadow:0 0 0 1px rgba(31,35,40,.18), 0 10px 26px rgba(31,35,40,.3);transition:none}',
    '.tk-dbg:not(.open){cursor:pointer}',
    '.tk-dbg[hidden]{display:none!important}',
    // align-self:center rather than the pill's stretch, so the dots sit on the
    // pill's vertical midline whatever height it is at.
    '.tk-dbg-grip{display:flex;align-items:center;gap:2px;padding:0 5px 0 8px;',
      'cursor:grab;border-radius:999px 0 0 999px;flex:0 0 auto;background:none;border:0}',
    '.tk-dbg.dragging .tk-dbg-grip{cursor:grabbing}',
    '.tk-dbg-grip span{display:flex;flex-direction:column;gap:2px}',
    '.tk-dbg-grip i{width:3px;height:3px;border-radius:50%;background:#8794a1;display:block;',
      'transition:background 90ms ease}',
    '.tk-dbg-grip:hover i{background:#0969da}',
    // Fills the pill's height rather than sitting in a box inside it: the
    // label takes only the space its 8px caps need, and the glyph gets the
    // rest via flex:1. Backgrounds stay transparent in every state except a
    // faint hover tint -- a filled rectangle inside a rounded pill reads as a
    // second object, which is exactly what it looked like.
    '.tk-dbg-toggle{display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:1px;border:0;background:none;cursor:pointer;',
      'color:#0969da;padding:0 10px 0 4px;border-radius:0 999px 999px 0;',
      'flex:0 0 auto;line-height:1}',
    '.tk-dbg.open .tk-dbg-toggle{border-radius:0;border-right:1px solid #e6eaef;padding-right:9px}',
    // No fill on hover, here or on any control below. The icon-only convention
    // is a muted resting colour resolving to the accent on hover, with the
    // tooltip carrying the meaning and opacity alone marking disabled -- a
    // filled rectangle inside a rounded pill reads as a second object.
    '.tk-dbg-toggle{color:#4a5b69}',
    '.tk-dbg-toggle:hover,.tk-dbg-toggle:active{color:#0969da;background:none}',
    '.tk-dbg-toggle .w{font-size:8px;font-weight:700;letter-spacing:.14em;line-height:1}',
    // Shown only while the pill is shut and replay is still live.
    '.tk-dbg-live{position:absolute;top:5px;right:6px;width:6px;height:6px;',
      'border-radius:50%;background:#0969da;box-shadow:0 0 0 1.5px #fff}',
    '.tk-dbg-live[hidden]{display:none}',
    '.tk-dbg-toggle{position:relative}',
    // flex:1 + a line-height of 1 lets the glyph occupy the whole remaining
    // height; font-size then sets how much of that it actually inks.
    '.tk-dbg-toggle .fa{display:block;font-size:17px;line-height:1}',
    '.tk-dbg-body{display:none;flex-direction:column;justify-content:center;',
      'gap:2px;padding:0 8px 0 6px;min-width:0;flex:1}',
    '.tk-dbg.open .tk-dbg-body{display:flex}',
    // Row 1 transport + jumps + exit; row 2 the slider and its counter.
    '.tk-dbg-row{display:flex;align-items:center;gap:1px;min-width:0}',
    '.tk-dbg-row.two,.tk-dbg-row.three{gap:6px}',
    '.tk-dbg-rate{font-size:10px;color:#4a5b69;white-space:nowrap;',
      'font-variant-numeric:tabular-nums;min-width:50px}',
    '.tk-dbg-speed{flex:0 0 72px;accent-color:#8794a1;height:12px;margin:0}',
    '.tk-dbg-spd-ic{font-size:10px;color:#8794a1;flex:0 0 auto}',
    /* Groups lay themselves out with flex, so `hidden` has to beat that: the
       attribute alone carries only UA-level display:none, which any stylesheet
       rule outranks -- an inline display:flex here would never hide. */
    '.tk-dbg [data-grp]{display:flex;align-items:center;gap:1px}',
    '.tk-dbg [data-grp][hidden]{display:none!important}',
    '.tk-dbg [data-grp="controls"]{flex-direction:column;align-items:stretch;',
      'gap:3px;flex:1;min-width:0}',
    '.tk-dbg-btn{border:0;background:none!important;cursor:pointer;color:#4a5b69;',
      'padding:3px 4px;line-height:1;flex:0 0 auto;font-size:13px;transition:color 90ms ease}',
    '.tk-dbg-btn:hover:not(:disabled){color:#0969da}',
    '.tk-dbg-btn:active:not(:disabled){color:#0550ae}',
    '.tk-dbg-btn:disabled{opacity:.32;cursor:default;color:#4a5b69}',
    '.tk-dbg-btn.bp:hover:not(:disabled){color:#cf222e}',
    // A toggle that is ON says so with the accent, never a filled chip -- and
    // for play/pause the glyph swaps too, which is the real signal.
    '.tk-dbg-btn[aria-pressed="true"]{color:#0969da}',
    // THE DEFAULT ACTION. Everything else in the row is a small muted glyph;
    // this one is labelled, larger and accent-coloured from rest, so what to
    // click to advance one line is not a guess. Still no background.
    '.tk-dbg-btn.primary{color:#0969da;font-size:12.5px;font-weight:600;',
      'display:flex;align-items:center;gap:4px;padding:3px 7px 3px 5px;',
      'letter-spacing:.01em}',
    '.tk-dbg-btn.primary .fa{font-size:14px}',
    '.tk-dbg-btn.primary:hover:not(:disabled){color:#0550ae}',
    '.tk-dbg-btn.primary:disabled{color:#8794a1;opacity:.6}',
    '.tk-dbg-slider{flex:1;min-width:0;margin:0;accent-color:#0969da;height:14px}',
    '.tk-dbg-pos{font-family:monospace;font-size:10.5px;color:#1f2328;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;padding:0 3px}',
    '.tk-dbg-note{font-size:10px;color:#59636e;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;flex:1;min-width:0}',
    '.tk-dbg-recording{font-size:14px;font-weight:600;color:#0969da;white-space:nowrap;letter-spacing:.01em}',
    '.tk-dbg-sep{width:1px;align-self:stretch;background:#c3d9ef;margin:5px 3px;flex:0 0 auto}',
    '.tk-dbg :focus-visible{outline:2px solid #0969da;outline-offset:1px}',
    '.tk-dbg-help{position:absolute;top:calc(100% + 6px);right:0;width:236px;background:#fff;',
      'border-radius:8px;padding:9px 11px;font-size:11.5px;line-height:1.45;color:#1f2328;',
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 6px 20px rgba(31,35,40,.2);',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '.tk-dbg-help[hidden]{display:none}',
    '.tk-dbg-help b{font-weight:600}',
    '.tk-dbg-help .dot{display:inline-block;width:9px;height:9px;border-radius:20px 0 0 20px;',
      'background:#cf222e;vertical-align:-1px;margin:0 2px}',
    '.tk-dbg-help p{margin:0 0 7px;font-size:11.5px;line-height:1.45;color:#1f2328}',
    '.tk-dbg-help p:last-child{margin:0;color:#59636e}',
    '.tk-dbg-vars{position:absolute;top:calc(100% + 6px);left:0;width:100%;background:#fff;border-radius:8px;',
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 6px 20px rgba(31,35,40,.18);',
      'padding:5px 6px;max-height:168px;overflow-y:auto;overflow-x:hidden;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '.tk-dbg-vars[hidden]{display:none}',
    '.tk-dbg-vrow{display:grid;grid-template-columns:16px 1fr auto 16px;gap:0 7px;',
      'align-items:center;padding:2px 1px;border-top:1px solid #f1f4f7}',
    '.tk-dbg-vrow:first-child{border-top:0}',
    '.tk-dbg-vn{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#1a7f37;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tk-dbg-vv{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#1f2328;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px;',
      'font-variant-numeric:tabular-nums;justify-self:end}',
    '.tk-dbg-vrow.changed .tk-dbg-vv{color:#0550ae;font-weight:600}',
    // Same no-fill rule as the pill: muted at rest, colour on hover.
    '.tk-dbg-vbtn{border:0;background:none!important;cursor:pointer;padding:1px;line-height:1;',
      'color:#c3cbd3;font-size:11px;transition:color 90ms ease}',
    '.tk-dbg-vbtn.rm:hover{color:#cf222e}',
    '.tk-dbg-vbtn.up:hover{color:#1a7f37}',
    '.tk-dbg-vars .empty{font-size:11px;color:#8794a1;padding:3px 2px;white-space:nowrap}',
    '@media (prefers-reduced-motion: reduce){.tk-dbg,.tk-dbg *{transition:none!important}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('tk-dbg-css')) return;
    var s = document.createElement('style');
    s.id = 'tk-dbg-css';
    s.appendChild(document.createTextNode(CSS));
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------
  function btn(id, icon, title, cls) {
    return '<button type="button" class="tk-dbg-btn' + (cls ? ' ' + cls : '') + '"'
         + ' data-act="' + id + '" title="' + title + '" aria-label="' + title + '">'
         + '<i class="fa ' + icon + '" aria-hidden="true"></i></button>';
  }

  var MARKUP =
      '<button type="button" class="tk-dbg-grip" data-grip="1"'
    +   ' title="Drag the debugger" aria-label="Move the debugger; arrow keys also move it">'
    +   '<span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span>'
    + '</button>'
    + '<button type="button" class="tk-dbg-toggle" data-act="toggle" aria-expanded="false"'
    +   ' title="Step through this program line by line">'
    +   '<span class="w">DEBUG</span><i class="fa fa-bug" aria-hidden="true"></i>'
    +   '<span class="tk-dbg-live" data-el="live" hidden'
    +     ' title="Still stepping - the output below is the recording, not a live run">'
    +   '</span>'
    + '</button>'
    + '<span class="tk-dbg-body">'
    +   '<span data-grp="launch">'
    +     btn('start', 'fa-step-forward', 'Record this program and step through it')
    +     '<span class="tk-dbg-recording">step through</span>'
    +   '</span>'
    +   '<span data-grp="recording" hidden>'
    +     '<span class="tk-dbg-recording">recording&hellip;</span>'
    +     btn('cancel', 'fa-times', 'Cancel the recording')
    +   '</span>'
    +   '<span data-grp="controls" hidden>'
    +     '<span class="tk-dbg-row">'
    +       btn('first', 'fa-fast-backward', 'First step')
    +       btn('back', 'fa-step-backward', 'Previous step')
    +       '<button type="button" class="tk-dbg-btn primary" data-act="fwd"'
    +         ' title="Run the next line (\u2192)" aria-label="Next step">'
    +         'Step<i class="fa fa-step-forward" aria-hidden="true"></i></button>'
    +       btn('last', 'fa-fast-forward', 'Last step')
    +       '<span class="tk-dbg-sep"></span>'
    +       '<button type="button" class="tk-dbg-btn" data-act="play" aria-pressed="false"'
    +         ' title="Play / pause" aria-label="Play / pause">'
    +         '<i class="fa fa-play" data-el="playicon" aria-hidden="true"></i></button>'
    +       '<span class="tk-dbg-sep"></span>'
    +       btn('prevbp', 'fa-chevron-circle-left', 'Previous breakpoint', 'bp')
    +       btn('nextbp', 'fa-chevron-circle-right', 'Next breakpoint', 'bp')
    +       btn('bphelp', 'fa-question-circle-o', 'What is a breakpoint?')
    +       '<span class="tk-dbg-sep"></span>'
    +       btn('exit', 'fa-times', 'Exit step-through')
    +     '</span>'
    +     '<span class="tk-dbg-row two">'
    +       '<input type="range" class="tk-dbg-slider" data-act="slider" min="0" max="0" value="0"'
    +         ' aria-label="Step position">'
    +       '<span class="tk-dbg-pos" data-el="pos">0 / 0</span>'
    +     '</span>'
    +     '<span class="tk-dbg-row three">'
    +       '<i class="fa fa-tachometer tk-dbg-spd-ic" aria-hidden="true"></i>'
    +       '<input type="range" class="tk-dbg-speed" data-act="speed" min="0" max="4" step="1"'
    +         ' value="2" aria-label="Playback speed">'
    +       '<span class="tk-dbg-rate" data-el="rate">1 / sec</span>'
    +       '<span class="tk-dbg-note" data-el="note"></span>'
    +     '</span>'
    +   '</span>'
    + '</span>';

  function mount() {
    if (mounted) return;
    injectCss();
    $layer = document.createElement('div');
    $layer.className = 'tk-dbg-layer';
    $dock = document.createElement('div');
    $dock.className = 'tk-dbg-dock';
    $pill = document.createElement('div');
    $pill.className = 'tk-dbg';
    $pill.setAttribute('role', 'group');
    $pill.setAttribute('aria-label', 'Step-through debugger');
    $pill.innerHTML = MARKUP;
    $pill.hidden = true;
    $dock.appendChild($pill);
    $help = document.createElement('div');
    $help.className = 'tk-dbg-help';
    $help.setAttribute('role', 'dialog');
    $help.setAttribute('aria-label', 'How to add a breakpoint');
    $help.hidden = true;
    $help.innerHTML =
        '<p><b>Set a breakpoint</b></p>'
      + '<p>Click the grey margin left of a line number. A red marker'
      + ' <span class="dot"></span> appears, and the two circled arrows jump'
      + ' to it \u2014 forwards or back.</p>'
      + '<p>Nothing pauses: the program has already run. A breakpoint is just a'
      + ' place to jump to, so add and remove them as you go.</p>';
    $dock.appendChild($help);
    $vars = document.createElement('div');
    $vars.className = 'tk-dbg-vars';
    $vars.setAttribute('aria-label', 'Variables so far');
    $vars.hidden = true;
    $dock.appendChild($vars);
    $layer.appendChild($dock);
    $vars.addEventListener('click', function(e) {
      var b = e.target.closest('[data-vact]');
      if (!b) return;
      var nm = b.getAttribute('data-var');
      if (b.getAttribute('data-vact') === 'rm') {
        dropped[nm] = true;
        var at = lifted.indexOf(nm);
        if (at >= 0) lifted.splice(at, 1);
      } else {
        var was = lifted.indexOf(nm);
        if (was >= 0) lifted.splice(was, 1);
        lifted.unshift(nm);
      }
      paintVars();
    });
    layerHost().appendChild($layer);
    wire();
    mounted = true;
  }

  var draggedSinceDown = false;

  // Autoplay controls no execution -- the recording is already a finished
  // array -- so it belongs in the panel rather than in pyodide.js. Five
  // discrete detents rather than a continuous slider: these are the five
  // speeds worth having, and a continuous control makes 1/sec fiddly to hit.
  var SPEEDS = [5, 2, 1, 0.5, 0.2];              // seconds per step
  var RATES  = ['1 / 5 s', '1 / 2 s', '1 / sec', '2 / sec', '5 / sec'];
  var speedIx = 2;
  var playTimer = null;

  function playing() { return playTimer !== null; }

  function stopPlay() {
    if (playTimer === null) return;
    clearInterval(playTimer);
    playTimer = null;
    paintPlay();
  }

  function startPlay() {
    if (!ctx || !ctx.actions || playTimer !== null) return;
    var s0 = {};
    try { s0 = ctx.getState() || {}; } catch (e) { return; }
    if (!s0.replaying) return;
    if (s0.idx >= s0.total) { try { ctx.actions.first(); } catch (e) {} }
    playTimer = setInterval(function() {
      var st = {};
      try { st = ctx.getState() || {}; } catch (e) { stopPlay(); return; }
      // At five steps a second a 5,000-step recording still takes sixteen
      // minutes, so autoplay is for watching a loop turn, not for traversing
      // a program: it stops at the end rather than wrapping.
      if (!st.replaying || st.idx >= st.total) { stopPlay(); return; }
      try { ctx.actions.step(1); } catch (e) { stopPlay(); }
    }, SPEEDS[speedIx] * 1000);
    paintPlay();
  }

  function paintPlay() {
    if (!mounted) return;
    var b = $pill.querySelector('[data-act="play"]');
    var i = el('playicon');
    var r = el('rate');
    if (b) b.setAttribute('aria-pressed', String(playing()));
    if (i) i.className = 'fa fa-' + (playing() ? 'pause' : 'play');
    if (r) r.textContent = RATES[speedIx];
  }

  // Opening the pill IS the request to step through -- the student should not
  // have to find a second button after it expands. Only when nothing is in
  // flight: re-expanding mid-replay must not throw the recording away, and
  // re-expanding after a deliberate exit leaves the launch button to click.
  function setExpanded(on, alsoRecord) {
    if (!on) { hideHelp(); if ($vars) $vars.hidden = true; }
    expanded = on;
    $pill.classList.toggle('open', on);
    var t = $pill.querySelector('[data-act="toggle"]');
    if (t) t.setAttribute('aria-expanded', String(on));
    place();
    paintVars();   // collapse hides it; re-expanding must bring it straight back
    if (!on || !alsoRecord || !ctx || !ctx.actions) return;
    // Deferred one tick so the expand animation and the (blocking, main-thread)
    // recording do not fight over the same frame. setTimeout, not
    // requestAnimationFrame: rAF is suspended while the tab is hidden or
    // occluded, so a trinket opened in a background tab would expand the pill
    // and then never record.
    setTimeout(function() { armRecording(0); }, 0);
  }

  // runStepThrough() refuses outright while a normal Run, the REPL or a worker
  // run is in flight, so a student who clicks DEBUG mid-run would get an open
  // pill and nothing else. Wait for the runner to go quiet instead, then
  // record -- and give up if they close the pill or start something else.
  function armRecording(tries) {
    if (!expanded || !ctx || !ctx.actions) return;
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { return; }
    if (s.recording || s.replaying) return;
    if (s.busy) {
      if (tries < 150) setTimeout(function() { armRecording(tries + 1); }, 200);
      return;                                   // ~30s, then leave the button
    }
    try { ctx.actions.start(); } catch (e) {}
    sync();
  }

  function hideHelp() {
    if (!$help || $help.hidden) return;
    $help.hidden = true;
    paintVars();                       // bring the list back
  }

  function toggleHelp() {
    if (!$help) return;
    if (!$help.hidden) { $help.hidden = true; return; }
    $help.hidden = false;
    if ($vars) $vars.hidden = true;   // they would sit on top of each other
  }

  var RM = '<svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"'
         + ' d="M13 4.2L11.8 3 8 6.8 4.2 3 3 4.2 6.8 8 3 11.8 4.2 13 8 9.2 11.8 13 13 11.8 9.2 8z"/></svg>';
  var UP = '<svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"'
         + ' d="M8 1l6 7H9.5v7h-3V8H2z"/></svg>';

  // Opt-OUT, not opt-in: every variable the student defines appears here by
  // itself, in the order it came into existence, and grows as they step. A
  // list you have to go and build is a list nobody builds.
  function paintVars() {
    if (!mounted || !ctx || !ctx.getVarModel) return;
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { s = {}; }
    if (!s.replaying || !expanded) { $vars.hidden = true; return; }

    var model = null, now = [], prev = [];
    try {
      model = ctx.getVarModel();
      now   = ctx.getVars(s.idx) || [];
      prev  = s.idx > 0 ? (ctx.getVars(s.idx - 1) || []) : [];
    } catch (e) { $vars.hidden = true; return; }
    if (!model) { $vars.hidden = true; return; }

    var vals = Object.create(null), was = Object.create(null), i;
    for (i = 0; i < now.length; i++) vals[now[i].name] = now[i].repr;
    for (i = 0; i < prev.length; i++) was[prev[i].name] = prev[i].repr;

    var names = [];
    for (i = 0; i < model.order.length; i++) {
      var nm = model.order[i];
      if (model.fromImport[nm]) continue;          // library furniture
      if (dropped[nm]) continue;                   // dismissed by the student
      if (model.firstStep[nm] > s.idx) continue;   // not defined yet at this step
      names.push(nm);
    }
    // Promoted names float to the top, most recently promoted first.
    names.sort(function (a, b) {
      var la = lifted.indexOf(a), lb = lifted.indexOf(b);
      if (la === lb) return 0;
      if (la < 0) return 1;
      if (lb < 0) return -1;
      return la - lb;
    });

    if (!names.length) { $vars.hidden = true; return; }

    var html = '';
    {
      for (i = 0; i < names.length; i++) {
        var n2 = names[i];
        var v = n2 in vals ? vals[n2] : null;
        var changed = v !== null && was[n2] !== undefined && was[n2] !== v;
        html += '<div class="tk-dbg-vrow' + (changed ? ' changed' : '') + '">'
          + '<button type="button" class="tk-dbg-vbtn rm" data-vact="rm" data-var="' + escAttr(n2)
          + '" title="Remove ' + escAttr(n2) + ' from this list" aria-label="Remove ' + escAttr(n2) + '">' + RM + '</button>'
          + '<span class="tk-dbg-vn" title="' + escAttr(n2) + '">' + escHtml(n2) + '</span>'
          + '<span class="tk-dbg-vv" title="' + escAttr(v === null ? 'not defined at this step' : v) + '">'
          + (v === null ? '&mdash;' : escHtml(v)) + '</span>'
          + '<button type="button" class="tk-dbg-vbtn up" data-vact="up" data-var="' + escAttr(n2)
          + '" title="Move ' + escAttr(n2) + ' to the top" aria-label="Move ' + escAttr(n2) + ' to the top">' + UP + '</button>'
          + '</div>';
      }
    }
    $vars.innerHTML = html;
    $vars.hidden = false;
  }

  function escHtml(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(t) { return escHtml(t).replace(/"/g, '&quot;'); }

  function el(name) { return $pill.querySelector('[data-el="' + name + '"]'); }
  function grp(name) { return $pill.querySelector('[data-grp="' + name + '"]'); }

  // ---------------------------------------------------------------------
  // Default position: the empty span of the file-tab bar
  // ---------------------------------------------------------------------
  //
  // Docked there by arithmetic rather than by parentage. Recomputed until the
  // student drags it, after which their position wins -- including across runs.
  function place() {
    if (placed || !$pill || $pill.hidden) return;
    var editor = document.querySelector('#editor');
    var nav = document.querySelector('#editor .tab-nav');
    var host = $layer.getBoundingClientRect();
    if (!editor || !nav || !host.width) return;
    var nr = nav.getBoundingClientRect();
    if (!nr.width) {
      if (placeTries++ < 40) setTimeout(place, 16);
      return;
    }

    // Line the pill up under the Run button, which is what was actually asked
    // for -- the row below Run, starting where Run starts.
    //
    // Not the last file tab (an earlier pass), and emphatically not
    // `.scrollable-content`: that <dl> runs wider than the bar and is clipped
    // by .tab-nav's overflow:hidden, so its rect reports an un-clipped right
    // edge past the editor pane entirely, which put the pill over the output.
    var run = document.querySelector('a.run-it');
    var rr = run ? run.getBoundingClientRect() : null;
    var strip = nav.querySelector('.scrollable-content');
    var tabsEls = strip ? strip.children : null;
    var lastTab = tabsEls && tabsEls.length ? tabsEls[tabsEls.length - 1] : null;
    var underRun = !!(rr && rr.width);
    var anchor = underRun ? rr.left
               : (lastTab ? lastTab.getBoundingClientRect().right : nr.left + 120);

    // And keep the whole pill inside the EDITOR pane. Clamping to the layer
    // (the whole embed) is not enough: the layer spans the output pane too,
    // so a wide expanded panel sat over the Variables table quite happily.
    var opts = nav.querySelector('.right-options');
    var or_ = opts ? opts.getBoundingClientRect() : null;
    var rightBound = (or_ && or_.width ? or_.left : editor.getBoundingClientRect().right) - 8;

    var left = anchor - host.left + (underRun ? 0 : 10);
    var maxLeft = rightBound - host.left - $dock.offsetWidth;
    var x = Math.max(6, Math.min(left, maxLeft));
    var y = Math.max(2, nr.top - host.top + 2);
    $dock.style.left = x + 'px';
    $dock.style.top = y + 'px';

    // Keep recomputing until two consecutive passes agree. The first call
    // happens inside initialize(), while the toolbar and the off-canvas column
    // are still settling -- a one-shot placement there reads a Run button that
    // has not reached its final x yet, and nothing later moves the pill,
    // because sync() only fires when the DEBUGGER's state changes. Converges
    // in two or three frames; bounded so a permanently unstable layout cannot
    // spin.
    var key = x + ',' + y;
    if (key !== placeLast && placeTries++ < 40) {
      placeLast = key;
      setTimeout(place, 16);   // not rAF: see armRecording
    }
  }

  // ---------------------------------------------------------------------
  // Paint from the debugger's own state -- this file owns no debugger state
  // ---------------------------------------------------------------------
  function sync() {
    if (!ctx || !mounted) return;
    // If the debugger left replay by any route, the timer has nothing to step.
    if (playing()) {
      var q = {};
      try { q = ctx.getState() || {}; } catch (e) { q = {}; }
      if (!q.replaying) stopPlay();
    }
    var avail = false;
    try { avail = !!ctx.isAvailable(); } catch (e) { avail = false; }
    $pill.hidden = !avail;
    if (!avail) { hideHelp(); if ($vars) $vars.hidden = true; return; }

    var s;
    try { s = ctx.getState() || {}; } catch (e) { return; }

    var live = el('live');
    if (live) live.hidden = !(s.replaying && !expanded);

    grp('launch').hidden     = s.recording || s.replaying;
    grp('recording').hidden  = !s.recording;
    grp('controls').hidden   = !s.replaying;
    if (!s.replaying) hideHelp();

    if (s.replaying) {
      paintPlay();
      var slider = $pill.querySelector('[data-act="slider"]');
      slider.max = s.total;
      slider.value = s.idx;
      el('pos').textContent = s.atEnd ? 'end' : (s.idx + 1) + ' / ' + s.total;
      el('note').textContent = s.note || '';
      var atStart = s.idx <= 0, atEnd = s.idx >= s.total;
      $pill.querySelector('[data-act="first"]').disabled = atStart;
      $pill.querySelector('[data-act="back"]').disabled = atStart;
      $pill.querySelector('[data-act="fwd"]').disabled = atEnd;
      $pill.querySelector('[data-act="last"]').disabled = atEnd;
      var noBp = !s.hasBreakpoints;
      $pill.querySelector('[data-act="prevbp"]').disabled = noBp;
      $pill.querySelector('[data-act="nextbp"]').disabled = noBp;
    }
    place();
    paintVars();
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function wire() {
    $pill.addEventListener('click', function(e) {
      // Collapsed, the whole pill is the target -- including the grip, so long
      // as the pointer did not actually travel (that is a drag, not a click).
      if (!expanded) {
        if (!draggedSinceDown) setExpanded(true, true);
        return;
      }
      // Expanded, the grip is a toggle as well: tap collapses, drag moves.
      if (e.target.closest('[data-grip]')) {
        if (!draggedSinceDown) setExpanded(false);
        return;
      }
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || b.tagName === 'INPUT') return;
      var act = b.getAttribute('data-act');
      if (act === 'toggle') {
        setExpanded(!expanded);
        return;
      }
      if (act === 'bphelp') { toggleHelp(); return; }
      hideHelp();
      if (act === 'play') { playing() ? stopPlay() : startPlay(); return; }

      var a = ctx && ctx.actions;
      if (!a) return;
      // Manual navigation pauses: stepping by hand while the timer also steps
      // would have the two fighting over the index.
      if (act !== 'start') stopPlay();
      try {
        switch (act) {
          case 'start':  a.start();      break;
          case 'cancel': a.cancel();     break;
          case 'first':  a.first();      break;
          case 'back':   a.step(-1);     break;
          case 'fwd':    a.step(1);      break;
          case 'last':   a.last();       break;
          case 'prevbp': a.jumpBp(-1);   break;
          case 'nextbp': a.jumpBp(1);    break;
          case 'exit':   a.exit(); setExpanded(false); break;
        }
      } catch (err) { /* never let the panel break the debugger */ }
      sync();
    });

    var slider = $pill.querySelector('[data-act="slider"]');
    slider.addEventListener('input', function() {
      if (!ctx || !ctx.actions) return;
      stopPlay();
      try { ctx.actions.stepTo(parseInt(this.value, 10) || 0); } catch (e) {}
    });

    $pill.querySelector('[data-act="speed"]').addEventListener('input', function() {
      speedIx = Math.max(0, Math.min(parseInt(this.value, 10) || 0, SPEEDS.length - 1));
      paintPlay();
      if (playing()) { stopPlay(); startPlay(); }   // re-arm, keep the position
    });

    dragging();
  }

  // Pointer drag by the grip, plus arrow keys while the grip has focus. The
  // grip is a <button> so it is reachable by Tab, and its own arrow keys are
  // stopped from bubbling -- otherwise they would reach the debugger's
  // document-level stepping handler and step the recording instead of moving
  // the panel. (Adjudicating those keys against Ace is slice 3.)
  function dragging() {
    var grip = $pill.querySelector('[data-grip]');
    var down = null;

    function bounds() { return $layer.getBoundingClientRect(); }
    function put(left, top) {
      var b = bounds();
      $dock.style.left = Math.max(4, Math.min(left, b.width - $pill.offsetWidth - 4)) + 'px';
      $dock.style.top  = Math.max(4, Math.min(top,  b.height - $pill.offsetHeight - 4)) + 'px';
      if (draggedSinceDown) placed = true;
    }

    grip.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      draggedSinceDown = false;
      var pr = $dock.getBoundingClientRect(), b = bounds();
      down = { dx: e.clientX - pr.left, dy: e.clientY - pr.top, bx: b.left, by: b.top,
               sx: e.clientX, sy: e.clientY };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      $pill.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function(e) {
      if (!down) return;
      // 4px of slop: a click always jitters a pixel or two, and treating that
      // as a drag would make the collapsed pill impossible to open by its grip.
      if (Math.abs(e.clientX - down.sx) > 4 || Math.abs(e.clientY - down.sy) > 4) {
        draggedSinceDown = true;
      }
      put(e.clientX - down.bx - down.dx, e.clientY - down.by - down.dy);
    });
    function end() { down = null; $pill.classList.remove('dragging'); }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    grip.addEventListener('keydown', function(e) {
      var map = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
      var d = map[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      put((parseFloat($dock.style.left) || 0) + d[0], (parseFloat($dock.style.top) || 0) + d[1]);
    });
  }

  // ---------------------------------------------------------------------
  // The hooks pyodide.js calls
  // ---------------------------------------------------------------------
  window.trinketDebugPanel = {
    init: function(handover) {
      ctx = handover;
      mount();
      sync();
      // Reposition with the layout while the student has not moved it. Passive
      // and cheap: place() returns immediately once `placed` is true.
      window.addEventListener('resize', place);
    },
    // Called wherever the debugger's own state changes.
    sync: sync,
    afterRun: function() { stopPlay(); sync(); },
    // Editing invalidates the recording's line numbers, so a marching
    // highlight would be walking over code that no longer means anything.
    onEditorChange: function() { stopPlay(); sync(); }
  };

})(window, document);
