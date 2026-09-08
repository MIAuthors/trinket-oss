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
  var armWaiting = false;  // queued a recording, waiting for the runner to idle
  // Replay ended because the student started typing, rather than because they
  // pressed the exit. The panel stays OPEN in that case and the variables
  // window carries the reason -- see paintVars().
  var editExited = false;
  var noteTimer = null;

  // A transient line in the panel's own note slot, for things the debugger
  // itself has no note for.
  function note(msg) {
    var n = el('note');
    if (!n) return;
    n.textContent = msg;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { if (el('note')) el('note').textContent = ''; }, 6000);
  }

  var varsPlaced = false;  // true once the window has been dragged off the pill
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
    //
    // It also ships `button:hover, button:focus { background-color; color:#fff }`
    // at (0,1,1), which outranks any plain class rule (0,1,0) in this file. The
    // background half is why the grip kept its blue wash however many times its
    // own background was set to none; blanket that here, once, for every control
    // and any added later. The COLOUR half is the vanishing-icon bug: a clicked
    // button is :focus, so its glyph went #fff on the white pill until the
    // pointer came back (the :hover rule below is (0,2,0) and wins), then went
    // white again on leaving. Confirmed by real click + screen capture in Chrome
    // 152 with the colours de-!important-ed: computed color rgb(255,255,255),
    // zero ink. Every colour a control sets below is therefore !important -- a
    // new button here needs one too, or Foundation's :focus paints it white.
    // (Scripted el.focus() in an unfocused browser pane does NOT reproduce it:
    // :focus only matches while the document itself has focus.)
    '.tk-dbg button,.tk-dbg input,.tk-dbg-vars button{margin:0}',
    '.tk-dbg button,.tk-dbg button:hover,.tk-dbg button:focus,.tk-dbg button:active,',
      '.tk-dbg-vars button,.tk-dbg-vars button:hover,.tk-dbg-vars button:focus,',
      '.tk-dbg-vars button:active',
      '{background:none!important;background-color:transparent!important;box-shadow:none;',
      'text-shadow:none}',
    '.tk-dbg-dock{position:absolute;pointer-events:none;display:inline-block;max-width:calc(100% - 12px)}',
    '.tk-dbg-dock > *,.tk-dbg-layer > *{pointer-events:auto}',
    '.tk-dbg{position:relative;display:flex;align-items:center;pointer-events:auto;',
      'background:#ffffff;border:0;border-radius:999px;',
      // The "outline" is the shadow's own hairline ring, not a border: a 1px
      // border plus a shadow reads as two edges at this radius.
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 3px 12px rgba(31,35,40,.18);',
      'width:72px;height:32px;font-size:13px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'user-select:none;-webkit-user-select:none;',
      'transition:width 170ms cubic-bezier(.2,.7,.3,1),height 170ms cubic-bezier(.2,.7,.3,1),box-shadow 140ms ease}',
    // Only the two axes change on open; the ring must survive both states.
    '.tk-dbg.open{width:296px;height:84px}',
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
      'flex:0 0 auto;line-height:1;transition:color 90ms ease}',
    '.tk-dbg.open .tk-dbg-toggle{border-radius:0;border-right:1px solid #e6eaef;padding-right:9px}',
    // No fill on hover, here or on any control below. The icon-only convention
    // is a muted resting colour resolving to the accent on hover, with the
    // tooltip carrying the meaning and opacity alone marking disabled -- a
    // filled rectangle inside a rounded pill reads as a second object.
    // !important is load-bearing: see the Foundation `button:focus` note above.
    '.tk-dbg-toggle{color:#4a5b69!important}',
    '.tk-dbg-toggle:hover,.tk-dbg-toggle:active{color:#0969da!important;background:none}',
    '.tk-dbg-toggle .w{font-size:8px;font-weight:700;letter-spacing:.14em;line-height:1}',
    // Shown only while the pill is shut and replay is still live.
    '.tk-dbg-live{position:absolute;top:5px;right:6px;width:6px;height:6px;',
      'border-radius:50%;background:#0969da;box-shadow:0 0 0 1.5px #fff}',
    '.tk-dbg-live[hidden]{display:none}',
    '.tk-dbg-toggle{position:relative}',
    // flex:1 + a line-height of 1 lets the glyph occupy the whole remaining
    // height; font-size then sets how much of that it actually inks.
    '.tk-dbg-toggle .fa{display:block;font-size:17px;line-height:1}',
    '.tk-dbg-bug{display:block;color:inherit}',
    '.tk-dbg-body{display:none;flex-direction:column;justify-content:center;',
      // Symmetric: the 2px bottom padding was pushing the (centred) content up
      // by a pixel, leaving 6 above against 8 below.
      'gap:3px;padding:0 8px 0 6px;min-width:0;flex:1;overflow:hidden}',
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
    '.tk-dbg [data-grp="controls"]{flex-direction:row;align-items:center;',
      'gap:5px;flex:1;min-width:0}',
    '.tk-dbg-grid{display:grid;grid-template-columns:auto auto;gap:3px 9px;',
      'justify-items:center;align-items:end;flex:1;min-width:0}',
    // The note is a third grid row. Empty -- which is almost always -- it still
    // occupied 6px plus a gap at the BOTTOM, which is what pushed everything
    // visible upward and left 2px of margin above against 13px below. Out of
    // flow until it has something to say.
    '.tk-dbg-grid > .tk-dbg-note{grid-column:1 / -1;justify-self:start}',
    '.tk-dbg-grid > .tk-dbg-note:empty{display:none}',
    // Exit sits outside the grid so it can centre against BOTH rows, and the
    // pill's right edge curls around it.
    '.tk-dbg-btn.exit{font-size:16px;padding:4px 4px;align-self:center}',
    // Needs :not(:disabled) to outrank the generic .tk-dbg-btn:hover rule --
    // they were tied on specificity and the generic one came later, so exit
    // hovered accent-blue rather than red.
    '.tk-dbg-btn.exit:hover:not(:disabled){color:#cf222e!important}',
    '.tk-dbg-btn{border:0;background:none!important;cursor:pointer;color:#4a5b69;',
      'padding:3px 4px;line-height:1;flex:0 0 auto;font-size:13px;transition:color 90ms ease;',
      'color:#4a5b69!important}',
    '.tk-dbg-btn:hover:not(:disabled){color:#0969da!important}',
    '.tk-dbg-btn:active:not(:disabled){color:#0550ae!important}',
    '.tk-dbg-btn:disabled{opacity:.32;cursor:default;color:#4a5b69!important}',
    // Navigation, so it hovers like every other navigation control. Red on
    // this pill is reserved for the one button that ends the session.
    '.tk-dbg-btn.bp:hover:not(:disabled){color:#0969da!important}',
    // The circle glyphs read small against the chevrons next door.
    '.tk-dbg-btn.bp,.tk-dbg-btn[data-act="bphelp"]{font-size:15px;padding:3px 4px}',
    // Chevrons read lighter and narrower than the filled triangles they
    // replace, so they get a size bump and tighter padding to hold the same
    // weight in the row.
    '.tk-dbg-btn.chev{font-size:17px;padding:2px 2px}',
    '.tk-dbg-btn.chev .fa{font-weight:700}',
    // A toggle that is ON says so with the accent, never a filled chip -- and
    // for play/pause the glyph swaps too, which is the real signal.
    '.tk-dbg-btn[aria-pressed="true"]{color:#0969da!important}',
    // THE DEFAULT ACTION. Everything else in the row is a small muted glyph;
    // this one is labelled, larger and accent-coloured from rest, so what to
    // click to advance one line is not a guess. Still no background.
    '.tk-dbg-btn.primary{color:#0969da!important;padding:3px 6px}',
    '.tk-dbg-btn.primary .fa{font-size:17px}',
    '.tk-dbg-btn.primary:hover:not(:disabled){color:#0550ae!important}',
    '.tk-dbg-btn.primary:disabled{color:#8794a1!important;opacity:.6}',
    '.tk-dbg-slidewrap{flex:0 0 70px;min-width:0;height:25px;display:flex;',
      'align-items:center;align-self:flex-end}',
    '.tk-dbg-slider{width:100%;min-width:0;flex:none;margin:0;accent-color:#0969da;',
      'height:14px}',

    '.tk-dbg-note{font-size:10px;color:#59636e;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;flex:0 1 auto;min-width:0;align-self:flex-end;padding-bottom:6px}',
    '.tk-dbg-recording{font-size:14px;font-weight:600;color:#0969da;white-space:nowrap;letter-spacing:.01em}',
    // Centred in the pill rather than pinned left: in the launch state it is
    // the only thing in the body, and after an edit-exit it is the one thing
    // the student is meant to press.
    '.tk-dbg [data-grp="launch"]{flex:1;justify-content:center}',
    // !important for the Foundation button:hover/:focus{color:#fff} reason
    // documented at the top of this block -- without it the phrase goes white
    // on the white pill the moment it is clicked.
    // The phrase IS the control now, so it needs a real hit area rather than
    // the 14px band the text alone occupies -- padding here is the click
    // target, not decoration.
    '.tk-dbg-launch{display:inline-flex;align-items:center;justify-content:center;',
      'border:0;cursor:pointer;padding:7px 14px;line-height:1;border-radius:999px;',
      'color:#0969da!important}',
    '.tk-dbg-launch:hover,.tk-dbg-launch:focus,.tk-dbg-launch:active',
      '{color:#0550ae!important}',
    // Beats .tk-dbg-recording's own colour (0,2,0 vs 0,1,0) so the glyph and
    // the phrase move together on hover instead of only the glyph.
    '.tk-dbg-launch .tk-dbg-recording{color:inherit}',
    '.tk-dbg-sep{width:1px;align-self:stretch;background:#c3d9ef;margin:5px 3px;flex:0 0 auto}',
    // A hairline round-rect says "these three are one subject" without adding
    // a fill: previous breakpoint, next breakpoint, and what a breakpoint is.
    // Three labelled groups. The caption is what lets the icons stay pure: two
    // different play buttons are unambiguous when one sits under STEP MODE and
    // the other under AUTO MODE, so neither needs a word inside it.
    '.tk-dbg-grp{display:flex;flex-direction:column;align-items:center;gap:1px;flex:0 0 auto}',
    '.tk-dbg-cap{font-size:7.5px;font-weight:700;letter-spacing:.09em;color:#8794a1;',
      'line-height:1;white-space:nowrap;text-transform:uppercase}',
    '.tk-dbg-box{display:flex;align-items:center;justify-content:center;gap:0;',
      'border:1px solid #dfe4ea;border-radius:999px;padding:0 3px;min-height:25px}',
    '.tk-dbg-grp.active .tk-dbg-box{border-color:#0969da;background:#f2f8fe}',
    // The transport is the busiest box and has the least room: five numeric
    // rates need every pixel, so this box runs tighter than the others rather
    // than looser. Measured fit is 186px of content in a 186px grid.
    '.tk-dbg-grp.auto .tk-dbg-box{gap:2px;padding:0 3px}',
    '.tk-dbg-grp.active .tk-dbg-cap{color:#0969da}',
    // A speed multiplier riding the glyph: 2 and 5 read at this size where a
    // second chevron would not. !important on the colour for the same
    // Foundation :focus reason as every other control here; tabular-nums so
    // the accent moving between 2 and 5 cannot shift the row's width.
    '.tk-dbg-btn.rate{display:inline-flex;align-items:center;justify-content:center;',
      'font-size:11px;font-weight:700;padding:2px 2px;line-height:1;',
      'font-variant-numeric:tabular-nums;color:#4a5b69!important}',
    '.tk-dbg-btn.rate:hover:not(:disabled){color:#0969da!important}',
    '.tk-dbg-btn.rate:active:not(:disabled){color:#0550ae!important}',
    '.tk-dbg-btn.frac{padding:2px 3px}',
    '.tk-dbg-frac{display:inline-flex;flex-direction:column;align-items:center;',
      'line-height:1;font-size:8px;font-weight:700;font-variant-numeric:tabular-nums}',
    '.tk-dbg-frac i{font-style:normal;display:block;padding:0 1px}',
    // The fraction's rule. currentColor so it follows the button through rest,
    // hover, active and aria-pressed without needing a rule for each.
    '.tk-dbg-frac i:last-child{border-top:1px solid currentColor;margin-top:1px;',
      'padding-top:1px}',

    '.tk-dbg-row.top{align-items:flex-end;gap:8px}',
    '.tk-dbg-row.two{align-items:flex-end;gap:7px}',
    '.tk-dbg :focus-visible{outline:2px solid #0969da;outline-offset:1px}',
    '.tk-dbg-help{position:absolute;top:calc(100% + 6px);right:0;width:236px;background:#fff;',
      'border-radius:8px;padding:9px 11px;font-size:11.5px;line-height:1.45;color:#1f2328;',
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 6px 20px rgba(31,35,40,.2);',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '.tk-dbg-help[hidden]{display:none}',
    // Attached: hung off the dock. Detached: absolute in the layer with its
    // own left/top, set in JS.
    // .attached is positioned in JS from the dock's rect; see placeVars().
    '.tk-dbg-vgrip{display:flex;align-items:center;gap:2px;padding:1px 2px 3px;',
      'cursor:grab;border:0;background:none;width:100%}',
    '.tk-dbg-vgrip.dragging{cursor:grabbing}',
    '.tk-dbg-vgrip span{display:flex;flex-direction:column;gap:2px}',
    '.tk-dbg-vgrip i{width:3px;height:3px;border-radius:50%;background:#c3cbd3;display:block;',
      'transition:background 90ms ease}',
    '.tk-dbg-vgrip:hover i{background:#0969da}',
    // The error banner. Red is otherwise reserved on this panel for the one
    // control that ends the session -- this is text rather than a control, and
    // error-red is a strong enough convention to be worth the second use.
    '.tk-dbg-verr{font-size:11.5px;font-weight:700;color:#cf222e;',
      'padding:1px 3px 5px;line-height:1.35;white-space:nowrap}',
    // The edit-exit message, in the slot the variable rows normally fill. Set
    // on the element itself, never only on the wrapper: Foundation styles bare
    // block text and an explicit rule on the element beats inheritance.
    '.tk-dbg-vmsg{font-size:11.5px;line-height:1.45;color:#1f2328;',
      'padding:1px 3px 4px;max-width:186px}',
    '.tk-dbg-help b{font-weight:600}',
    '.tk-dbg-help .dot{display:inline-block;width:9px;height:9px;border-radius:20px 0 0 20px;',
      'background:#cf222e;vertical-align:-1px;margin:0 2px}',
    '.tk-dbg-help p{margin:0 0 7px;font-size:11.5px;line-height:1.45;color:#1f2328}',
    '.tk-dbg-help p:last-child{margin:0;color:#59636e}',
    // Content-sized rather than pill-width: `x = 3 (int)` needs a fraction of
    // 352px, and a wide box with the name pinned left and the value pinned
    // right made the two hard to read as one statement.
    '.tk-dbg-vars{position:absolute;width:max-content;',
      'min-width:132px;max-width:100%;min-height:34px;background:#fff;border-radius:8px;',
      // resize needs a non-visible overflow, which it already has. The native
      // handle is the bottom-right CORNER only -- browsers give no edge grips
      // without hand-built ones, which is not worth the code here.
      'resize:both;',
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 6px 20px rgba(31,35,40,.18);',
      'padding:5px 6px;overflow:auto;',
      // 168px was a hard cap, so the resize grip could never grow the box
      // past about six rows. A generous ceiling instead: short lists stay
      // short (height is auto), long ones scroll, and dragging works up to
      // most of the viewport.
      'max-height:70vh;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '.tk-dbg-vars[hidden]{display:none}',
    // x, a deliberate gap, then the up-arrow: the two sit side by side and one
    // of them is destructive, so they do not share an edge.
    '.tk-dbg-vrow{display:grid;grid-template-columns:14px 4px 14px 1fr;gap:0 2px;',
      'align-items:center;padding:2px 6px 2px 3px;border-top:1px solid #f1f4f7;border-radius:4px}',
    '.tk-dbg-vrow:first-child{border-top:0}',
    '.tk-dbg-stmt{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:4px;',
      'cursor:default}',
    '.tk-dbg-vn{color:#1a7f37}',
    '.tk-dbg-vv{color:#1f2328;font-variant-numeric:tabular-nums}',
    '.tk-dbg-vt{color:#8794a1}',
    // The variable this step just defined or changed. A row tint, not a
    // control fill -- this one is a table row and wants to be found at a
    // glance while stepping.
    '.tk-dbg-vrow.changed{background:#eaf3fd}',
    '.tk-dbg-vrow.changed .tk-dbg-vv{color:#0550ae;font-weight:600}',
    '.tk-dbg-vrow.changed .tk-dbg-vn{font-weight:600}',
    // Same no-fill rule as the pill: muted at rest, colour on hover.
    '.tk-dbg-vbtn{border:0;background:none!important;cursor:pointer;padding:1px;line-height:1;',
      'color:#c3cbd3!important;font-size:11px;transition:color 90ms ease}',
    '.tk-dbg-vbtn.rm:hover{color:#cf222e!important}',
    '.tk-dbg-vbtn.up:hover{color:#1a7f37!important}',
    // Promotion is sticky, so the control that did it says so permanently
    // rather than only while the pointer is on it.
    '.tk-dbg-vbtn.up.on{color:#1a7f37!important}',
    '.tk-dbg-vars .empty{font-size:11px;color:#8794a1;padding:3px 2px;white-space:nowrap}',
    '.tk-dbg-showall{display:block;width:100%;text-align:left;border:0;cursor:pointer;',
      'font-size:10.5px;color:#0969da!important;padding:3px 2px 1px 24px;',
      'border-top:1px solid #f1f4f7;margin-top:2px}',
    '.tk-dbg-showall:hover{color:#0550ae!important;text-decoration:underline}',
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

  // A rate button carries a NUMERAL, not a glyph. There is no established
  // glyph for slow motion -- players use numeric multipliers (YouTube's
  // 0.25x/0.5x), a word ("Slower"), or a settings menu, and none of that is a
  // shape. A numeral also makes the running speed readable at a glance, which
  // no chevron ever did: nobody hovers a control that is already playing.
  function rate(id, label, title) {
    return '<button type="button" class="tk-dbg-btn rate" data-act="' + id + '"'
         + ' title="' + title + '" aria-label="' + title + '">' + label + '</button>';
  }

  // Slow rates are true fractions, numerator over denominator across a
  // horizontal rule. That is the right typography for 1/5, and it spends the
  // box's VERTICAL space rather than its scarce horizontal space: measured in
  // a replica of the pill, the inline "1/5x" form wants 124px against the 89px
  // the AUTO column gets, while the stacked form fits. The full phrase lives
  // on aria-label and the glyph is aria-hidden, so a screen reader says "play
  // at one line every five seconds" rather than "one five".
  function frac(id, num, den, title) {
    return '<button type="button" class="tk-dbg-btn rate frac" data-act="' + id + '"'
         + ' title="' + title + '" aria-label="' + title + '">'
         + '<span class="tk-dbg-frac" aria-hidden="true">'
         + '<i>' + num + '</i><i>' + den + '</i></span></button>';
  }

  var MARKUP =
      '<button type="button" class="tk-dbg-grip" data-grip="1"'
    +   ' title="Drag the debugger" aria-label="Move the debugger; arrow keys also move it">'
    +   '<span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span>'
    + '</button>'
    + '<button type="button" class="tk-dbg-toggle" data-act="toggle" aria-expanded="false"'
    +   ' title="Step through this program line by line">'
    +   '<span class="w">DEBUG</span>'
    +   '<svg class="tk-dbg-bug" width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">'
    +     '<g fill="currentColor">'
    +       '<ellipse cx="8" cy="9.5" rx="3.4" ry="4.1"/><circle cx="8" cy="4.1" r="2.15"/>'
    +       '<path d="M8.7 1.15l1.9-1.05.5.9-1.9 1.05zM5.4 1.05l.5-.9 1.9 1.05-.5.9z'
    +         'M1.15 7.15l3.15.6-.2 1-3.15-.6zM11.9 7.75l3.15-.6.2 1-3.15.6z'
    +         'M1.5 12.4l2.85-1.45.5.9-2.85 1.45zM11.65 10.95l2.85 1.45-.5.9-2.85-1.45z"/>'
    +     '</g></svg>'
    +   '<span class="tk-dbg-live" data-el="live" hidden'
    +     ' title="Still stepping - the output below is the recording, not a live run">'
    +   '</span>'
    + '</button>'
    + '<span class="tk-dbg-body">'
    +   '<span data-grp="launch">'
          // Glyph AND phrase inside one button, centred. The words used to sit
          // outside the button, so clicking the only text in the pill did
          // nothing -- and after an edit closes the debugger this is the whole
          // affordance, so the phrase has to be the target.
    +     '<button type="button" class="tk-dbg-launch" data-act="start"'
    +       ' title="Record this program and step through it">'
    +       '<span class="tk-dbg-recording" data-el="launchlabel">step through</span>'
    +     '</button>'
    +   '</span>'
    +   '<span data-grp="recording" hidden>'
    +     '<span class="tk-dbg-recording" data-el="busy">Recording&hellip;</span>'
    +     btn('cancel', 'fa-times', 'Cancel')
    +   '</span>'
    +   '<span data-grp="controls" hidden>'
    +     '<span class="tk-dbg-grid">'
    +       '<span class="tk-dbg-grp step"><span class="tk-dbg-cap">Step mode</span>'
    +         '<span class="tk-dbg-box">'
    +           btn('first', 'fa-fast-backward', 'Back to the first step')
    +           btn('back', 'fa-step-backward', 'Back one line')
    +           btn('fwd', 'fa-step-forward', 'Run the next line', 'primary')
    +           btn('last', 'fa-fast-forward', 'Forward to the last step')
    +         '</span>'
    +       '</span>'
    +       '<span class="tk-dbg-grp auto"><span class="tk-dbg-cap">Auto mode</span>'
    +         '<span class="tk-dbg-box">'
    +           frac('slow5', '1', '5', 'Play at one line every 5 seconds')
    +           frac('slow2', '1', '2', 'Play at one line every 2 seconds')
    +           '<button type="button" class="tk-dbg-btn" data-act="play" aria-pressed="false"'
    +             ' title="Play at 1 line per second, or pause" aria-label="Play or pause">'
    +             '<i class="fa fa-play" data-el="playicon" aria-hidden="true"></i></button>'
    +           rate('ff2', '2', 'Play at 2 lines per second')
    +           rate('ff5', '5', 'Play at 5 lines per second')
    +         '</span>'
    +       '</span>'
    +       '<span class="tk-dbg-grp"><span class="tk-dbg-cap">Breakpoints</span>'
    +         '<span class="tk-dbg-box">'
    +           btn('prevbp', 'fa-chevron-circle-left', 'Previous breakpoint', 'bp')
    +           btn('nextbp', 'fa-chevron-circle-right', 'Next breakpoint', 'bp')
    +           btn('bphelp', 'fa-question-circle-o', 'What is a breakpoint?')
    +         '</span>'
    +       '</span>'
    +       '<span class="tk-dbg-slidewrap">'
    +         '<input type="range" class="tk-dbg-slider" data-act="slider" min="0" max="0" value="0"'
    +           ' aria-label="Step position">'
    +       '</span>'
    +       '<span class="tk-dbg-note" data-el="note"></span>'
    +     '</span>'
    +     '<button type="button" class="tk-dbg-btn exit" data-act="exit"'
    +       ' title="Leave step-through" aria-label="Leave step-through">'
    +       '<i class="fa fa-times" aria-hidden="true"></i></button>'
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
    $vars.classList.add('attached');
    $vars.hidden = true;
    // In the LAYER, not the dock: a child of the dock cannot outlive the
    // dock's position, and the point is to move it independently.
    $layer.appendChild($dock);
    $layer.appendChild($vars);
    // Delegated, because paintVars() rewrites innerHTML and replaces the grip.
    $vars.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('[data-vgrip]')) return;
      draggable($vars, '[data-vgrip]', $vars, detachVars);
      var g = $vars.querySelector('[data-vgrip]');
      if (g && !g.__wired) {
        g.__wired = true;
        g.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, bubbles: false
        }));
      }
    }, true);

    $vars.addEventListener('click', function(e) {
      if (e.target.closest('[data-vgrip]')) return;   // that is the drag handle
      var b = e.target.closest('[data-vact]');
      if (!b) return;
      var nm = b.getAttribute('data-var');
      if (b.getAttribute('data-vact') === 'showall') {
        dropped = {};
        paintVars();
        return;
      }
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
  //
  // ONE DIRECTION, and monotonic: slow on the left, fast on the right. Auto
  // mode used to run backwards, which asked one row to carry two axes (left
  // meant direction, outer meant rate) and forced a second vocabulary for
  // "backwards" -- chevrons meaning rewind-at-speed sitting next to STEP
  // MODE's transport glyphs, where the double triangle means jump-to-first.
  // Every video player a student has used reads the double triangle as
  // rewind, so the two rows disagreed about the same shape. Stepping back one
  // line is what backwards is actually for, and STEP MODE already does it;
  // watching a loop turn SLOWLY is what the freed left-hand buttons now do.
  var TRANSPORT = {
      slow5 : { rate: 1 / 5 }   // one line every five seconds
    , slow2 : { rate: 1 / 2 }   // one line every two seconds
    , play  : { rate: 1 }
    , ff2   : { rate: 2 }
    , ff5   : { rate: 5 }
  };
  var mode = 'step';       // 'step' or 'auto' -- whichever was last driven
  var playAct = null;      // which transport button is driving, or null
  var playTimer = null;

  function playing() { return playTimer !== null; }

  function stopPlay() {
    if (playTimer === null) return;
    clearInterval(playTimer);
    playTimer = null;
    playAct = null;
    paintPlay();
  }

  function startPlay(act) {
    if (!ctx || !ctx.actions) return;
    var t = TRANSPORT[act];
    if (!t) return;
    if (playTimer !== null) { clearInterval(playTimer); playTimer = null; }
    var s0 = {};
    try { s0 = ctx.getState() || {}; } catch (e) { return; }
    if (!s0.replaying) return;
    // Parked at the end: restart from the top, so the press does something
    // rather than nothing -- the same thing a player's play button does once
    // the video has finished.
    if (s0.idx >= s0.total) { try { ctx.actions.first(); } catch (e) {} }
    playAct = act;
    playTimer = setInterval(function() {
      var st = {};
      try { st = ctx.getState() || {}; } catch (e) { stopPlay(); return; }
      // Stops at whichever end it reaches rather than wrapping: at five lines a
      // second a 5,000-step recording still takes sixteen minutes, so auto mode
      // is for watching a loop turn, not traversing a program.
      if (!st.replaying || st.idx >= st.total) { stopPlay(); return; }
      try { ctx.actions.step(1); } catch (e) { stopPlay(); }
    }, (1 / t.rate) * 1000);
    paintPlay();
  }

  function paintPlay() {
    if (!mounted) return;
    // Whichever button is driving reads as pressed; the centre one also swaps
    // its glyph, since that is the one a student reads as "playing".
    for (var act in TRANSPORT) {
      var b = $pill.querySelector('[data-act="' + act + '"]');
      if (b) b.setAttribute('aria-pressed', String(playAct === act));
    }
    var i = el('playicon');
    // Pause whenever ANYTHING in auto mode is running, not only when the centre
    // button started it: a rate running at 2 with a play glyph showing is a lie
    // about what the button will do. The driving button also carries the accent
    // via aria-pressed, which is what makes the CURRENT SPEED visible while
    // playing -- the old chevrons conveyed rate by shape alone, and nobody
    // hovers a running control to read a tooltip.
    if (i) i.className = 'fa fa-' + (playAct !== null ? 'pause' : 'play');
    paintMode();
  }

  // Exactly one box is highlighted, so which mode a press will act in is never
  // a guess. Pressing a control in the other box moves the highlight.
  function paintMode() {
    if (!mounted) return;
    var groups = $pill.querySelectorAll('.tk-dbg-grp');
    for (var k = 0; k < groups.length; k++) {
      var isAuto = groups[k].classList.contains('auto');
      var isStep = groups[k].classList.contains('step');
      groups[k].classList.toggle('active',
        (isAuto && mode === 'auto') || (isStep && mode === 'step'));
    }
  }

  // Opening the pill IS the request to step through -- the student should not
  // have to find a second button after it expands. Only when nothing is in
  // flight: re-expanding mid-replay must not throw the recording away, and
  // re-expanding after a deliberate exit leaves the launch button to click.
  function setExpanded(on, alsoRecord) {
    // Coming home on collapse means a window dragged somewhere unhelpful is
    // always one collapse away from being findable again.
    if (!on) {
      hideHelp();
      varsPlaced = false;
      editExited = false;   // collapsing dismisses the message
      if ($vars) $vars.hidden = true;
    }
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
    if (!expanded || !ctx || !ctx.actions) { armWaiting = false; return; }
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { return; }
    if (s.recording || s.replaying) return;
    if (s.busy) {
      if (tries < 150) {
        armWaiting = true;
        setTimeout(function() { armRecording(tries + 1); }, 200);
        sync();
      } else {
        // Gave up after ~30s. Say so rather than sitting there: the launch
        // button comes back and the student can try again.
        armWaiting = false;
        note('the program is still running \u2014 press again when it stops');
        sync();
      }
      return;
    }
    armWaiting = false;
    // A new recording is a fresh start: anything hidden belonged to the old
    // one, and the highlight starts on step mode rather than inheriting
    // whichever half happened to drive the previous recording.
    dropped = {};
    lifted = [];
    mode = 'step';
    editExited = false;   // the message has been answered by re-recording
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
    showHelp();
  }

  function showHelp() {
    if (!$help) return;
    $help.hidden = false;
    if ($vars) $vars.hidden = true;   // they would sit on top of each other
  }

  var VGRIP = '<button type="button" class="tk-dbg-vgrip" data-vgrip="1"'
            + ' title="Drag this window" aria-label="Move the variables window;'
            + ' arrow keys also move it">'
            + '<span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span>'
            + '</button>';

  var RM = '<svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"'
         + ' d="M13 4.2L11.8 3 8 6.8 4.2 3 3 4.2 6.8 8 3 11.8 4.2 13 8 9.2 11.8 13 13 11.8 9.2 8z"/></svg>';
  var UP = '<svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"'
         + ' d="M8 1l6 7H9.5v7h-3V8H2z"/></svg>';

  // Opt-OUT, not opt-in: every variable the student defines appears here by
  // itself, in the order it came into existence, and grows as they step. A
  // list you have to go and build is a list nobody builds.
  var VAL_CHARS = 34;   // displayed; the tooltip carries what the recorder kept

  function clipVal(v) {
    return v.length > VAL_CHARS ? v.slice(0, VAL_CHARS - 1) + '\u2026' : v;
  }

  // Renders the variables window with whatever there is to show, or hides it
  // when there is nothing at all. Needed because an error banner has to appear
  // even in the states that used to hide the window outright -- a syntax error
  // records zero steps, so there is no model and no rows, and that is exactly
  // when the student most needs telling why.
  function varsHtml(inner) {
    if (!inner) { $vars.hidden = true; return; }
    $vars.innerHTML = VGRIP + inner;
    $vars.hidden = false;
    placeVars();
  }

  function paintVars() {
    if (!mounted || !ctx || !ctx.getVarModel) return;
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { s = {}; }
    if (!s.replaying || !expanded) {
      // Editing ended the replay, so say so where the values used to be. This
      // window is the right channel for it and #debug-note is not: the note
      // lives inside #debug-controls, which is only un-hidden DURING replay,
      // so anything written there at exit time goes into a display:none box.
      if (editExited && expanded) {
        $vars.innerHTML = VGRIP + '<div class="tk-dbg-vmsg">'
          + 'Step-through debugger exited so you can edit the code.</div>';
        $vars.hidden = false;
        placeVars();
        return;
      }
      $vars.hidden = true;
      return;
    }

    // Top of the window, bold and red: the one thing worth knowing before any
    // value. Shown for the whole replay, not only at the last step -- the run
    // ends badly whichever step you are looking at.
    var err = '';
    if (s.hasError) {
      err = '<div class="tk-dbg-verr">'
          + (s.errorLine ? 'Error on line ' + s.errorLine
                         : 'The program ended with an error')
          + '</div>';
    }

    var model = null, now = [], prev = [];
    try {
      model = ctx.getVarModel();
      now   = ctx.getVars(s.idx) || [];
      prev  = s.idx > 0 ? (ctx.getVars(s.idx - 1) || []) : [];
    } catch (e) { varsHtml(err); return; }
    if (!model) { varsHtml(err); return; }

    var vals = Object.create(null), was = Object.create(null);
    var types = Object.create(null), i;
    for (i = 0; i < now.length; i++) {
      vals[now[i].name] = now[i].repr;
      types[now[i].name] = now[i].type;
    }
    for (i = 0; i < prev.length; i++) was[prev[i].name] = prev[i].repr;

    // Count what the student has hidden, so it can be offered back. Dismissing
    // a variable used to be irreversible for the whole page session: no reset,
    // no message, no way back -- and silently losing the variable you are
    // debugging is the worst failure this panel could have.
    var hidden = 0;
    var names = [];
    for (i = 0; i < model.order.length; i++) {
      var nm = model.order[i];
      if (model.fromImport[nm]) continue;          // library furniture
      if (dropped[nm]) { hidden++; continue; }     // dismissed by the student
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

    if (!names.length && !hidden) { varsHtml(err); return; }

    var html = '';
    {
      for (i = 0; i < names.length; i++) {
        var n2 = names[i];
        var v = n2 in vals ? vals[n2] : null;
        // Newly defined counts as changed too -- the first assignment is the
        // most recent update there has been.
        var changed = v !== null && (was[n2] === undefined || was[n2] !== v);
        var ty = n2 in types ? types[n2] : null;
        var shown = v === null ? null : clipVal(v);
        var stmt = v === null
          ? escHtml(n2) + ' <span class="tk-dbg-vt">not defined yet</span>'
          : '<span class="tk-dbg-vn">' + escHtml(n2) + '</span> = '
              + '<span class="tk-dbg-vv">' + escHtml(shown) + '</span>'
              + (ty ? ' <span class="tk-dbg-vt">(' + escHtml(ty) + ')</span>' : '');
        html += '<div class="tk-dbg-vrow' + (changed ? ' changed' : '') + '">'
          + '<button type="button" class="tk-dbg-vbtn rm" data-vact="rm" data-var="' + escAttr(n2)
          + '" title="Remove ' + escAttr(n2) + ' from this list" aria-label="Remove ' + escAttr(n2) + '">' + RM + '</button>'
          + '<span></span>'
          + '<button type="button" class="tk-dbg-vbtn up' + (lifted.indexOf(n2) >= 0 ? ' on' : '')
          + '" data-vact="up" data-var="' + escAttr(n2) + '" aria-pressed="'
          + (lifted.indexOf(n2) >= 0) + '" title="'
          + (lifted.indexOf(n2) >= 0 ? escAttr(n2) + ' is pinned to the top' : 'Move ' + escAttr(n2) + ' to the top')
          + '">' + UP + '</button>'
          + '<span class="tk-dbg-stmt" title="'
          + escAttr(v === null ? n2 + ' is not defined at this step'
                    : n2 + ' = ' + v + (v.length > VAL_CHARS ? '' : '')) + '">'
          + stmt + '</span>'
          + '</div>';
      }
    }
    if (hidden) {
      html += '<button type="button" class="tk-dbg-showall" data-vact="showall">'
            + hidden + ' hidden \u2014 show all</button>';
    }
    varsHtml(err + html);
  }

  // Attached: CSS hangs it off the dock and there is nothing to compute.
  // Detached: it keeps whatever coordinates the student dragged it to, clamped
  // into the layer so a resize or a window change cannot strand it offscreen.
  function placeVars() {
    if (!$vars || $vars.hidden) return;
    var b = $layer.getBoundingClientRect();
    if (!varsPlaced) {
      $vars.classList.add('attached');
      var dr = $dock.getBoundingClientRect();
      if (!dr.width) return;
      $vars.style.left = Math.round(dr.left - b.left) + 'px';
      $vars.style.top = Math.round(dr.bottom - b.top + 6) + 'px';
      return;
    }
    $vars.classList.remove('attached');
    var x = parseFloat($vars.style.left) || 0, y = parseFloat($vars.style.top) || 0;
    $vars.style.left = Math.max(4, Math.min(x, b.width - $vars.offsetWidth - 4)) + 'px';
    $vars.style.top = Math.max(4, Math.min(y, b.height - 28)) + 'px';
  }

  // Detaching happens on the first drag: freeze where it currently sits, in
  // layer coordinates, then let the pointer take over from there.
  function detachVars() {
    if (varsPlaced) return;
    var vr = $vars.getBoundingClientRect(), b = $layer.getBoundingClientRect();
    varsPlaced = true;
    $vars.classList.remove('attached');
    $vars.style.left = Math.round(vr.left - b.left) + 'px';
    $vars.style.top = Math.round(vr.top - b.top) + 'px';
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
    // Prefer Run's left edge -- but never overlap the file tabs, which would
    // make them unclickable. On a narrow window the toolbar compresses and Run
    // slides left of the tabs, so take whichever is further right.
    var tabRight = lastTab ? lastTab.getBoundingClientRect().right + 8 : null;
    var underRun = !!(rr && rr.width);
    var anchor = underRun ? rr.left
               : (tabRight !== null ? tabRight : nr.left + 120);
    if (tabRight !== null && anchor < tabRight) anchor = tabRight;

    // And keep the whole pill inside the EDITOR pane. Clamping to the layer
    // (the whole embed) is not enough: the layer spans the output pane too,
    // so a wide expanded panel sat over the Variables table quite happily.
    var opts = nav.querySelector('.right-options');
    var or_ = opts ? opts.getBoundingClientRect() : null;
    var rightBound = (or_ && or_.width ? or_.left : editor.getBoundingClientRect().right) - 8;

    var left = anchor - host.left;
    // The expanded pill is 412px. On a narrow window the editor pane is
    // narrower than that, and clamping into the pane would shove it hard left
    // and still overflow -- so when it cannot fit the pane, clamp to the whole
    // embed instead. It is draggable either way.
    if ($dock.offsetWidth > rightBound - nr.left) rightBound = host.left + host.width - 6;
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
    placeVars();   // attached, it hangs off the dock, so it moves when this does
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

    // Entering a recording by ANY route answers the edit-exit message, so this
    // is the one place that clears it -- not armRecording, which only covers
    // the open-and-record click. Miss this and pressing Run while replaying
    // takes the student out of replay and then tells them they left "so you
    // can edit the code", which is not what they did.
    if (s.recording || s.replaying) editExited = false;

    var live = el('live');
    if (live) live.hidden = !(s.replaying && !expanded);

    // Three states, not two: recording, waiting for the runner to go quiet
    // before it can start recording, and idle. The middle one used to render
    // as "Recording..." with nothing happening, which is indistinguishable
    // from a recording that has hung.
    // "step through" for a first recording; "Restart Debugger" once one has
    // been closed by an edit, because by then the student is not discovering
    // the feature -- they are getting back to where they were.
    var ll = el('launchlabel');
    if (ll) ll.textContent = editExited ? 'Restart Debugger' : 'step through';

    var waiting = !s.recording && !s.replaying && s.busy && expanded && armWaiting;
    grp('launch').hidden     = s.recording || s.replaying || waiting;
    grp('recording').hidden  = !(s.recording || waiting);
    var busyEl = el('busy');
    if (busyEl) {
      busyEl.innerHTML = s.recording ? 'Recording&hellip;' : 'Waiting for the run&hellip;';
    }
    grp('controls').hidden   = !s.replaying;
    if (!s.replaying) hideHelp();

    if (s.replaying) {
      paintPlay();
      var slider = $pill.querySelector('[data-act="slider"]');
      slider.max = s.total;
      slider.value = s.idx;
      slider.title = s.atEnd
        ? 'The end of the recording \u2014 drag to go back'
        : 'Step ' + (s.idx + 1) + ' of ' + s.total + ' \u2014 drag to scrub';
      el('note').textContent = s.note || '';
      var atStart = s.idx <= 0, atEnd = s.idx >= s.total;
      $pill.querySelector('[data-act="first"]').disabled = atStart;
      $pill.querySelector('[data-act="back"]').disabled = atStart;
      $pill.querySelector('[data-act="fwd"]').disabled = atEnd;
      $pill.querySelector('[data-act="last"]').disabled = atEnd;
      // Deliberately NOT disabled with no breakpoints set: a dead control
      // teaches nothing, and clicking one is the moment the student is asking
      // what breakpoints are. The handler answers with the hint instead.
      $pill.querySelector('[data-act="prevbp"]').disabled = false;
      $pill.querySelector('[data-act="nextbp"]').disabled = false;
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
      if (act === 'prevbp' || act === 'nextbp') {
        var st = {};
        try { st = ctx.getState() || {}; } catch (e) { st = {}; }
        if (!st.hasBreakpoints) { showHelp(); return; }
      }
      hideHelp();
      // Any transport button: pressing the one already driving pauses; pressing
      // another switches speed without stopping first.
      if (TRANSPORT[act]) {
        mode = 'auto';
        // The centre button is the master: while anything is playing it shows a
        // pause glyph and pausing is what it does. The flanking buttons switch
        // speed, and pressing the one already driving pauses.
        if (act === 'play' && playAct !== null) stopPlay();
        else if (playAct === act) stopPlay();
        else startPlay(act);
        return;
      }
      // Breakpoint jumps belong in this list too: they move the playhead
      // discretely and they stop autoplay, which is exactly what step mode
      // means. Leaving them out left AUTO lit while the student was plainly
      // stepping, with the accented primary action sitting in the unlit box.
      if (act === 'first' || act === 'back' || act === 'fwd' || act === 'last'
          || act === 'prevbp' || act === 'nextbp') {
        mode = 'step';
      }

      var a = ctx && ctx.actions;
      if (!a) return;
      // Manual navigation pauses: stepping by hand while the timer also steps
      // would have the two fighting over the index.
      if (act !== 'start') stopPlay();
      try {
        switch (act) {
          // Through armRecording rather than straight to a.start(), so the
          // launch button gets what the open-and-record click already had: the
          // 200ms wait while the runner is busy (a bare start() returns
          // silently and looks like a dead button), plus the fresh-start reset
          // of dismissed and promoted variables from the previous recording.
          case 'start':  armRecording(0);  break;
          case 'cancel': a.cancel();     break;
          case 'first':  a.first();      break;
          case 'back':   a.step(-1);     break;
          case 'fwd':    a.step(1);      break;
          case 'last':   a.last();       break;
          case 'prevbp': a.jumpBp(-1);   break;
          case 'nextbp': a.jumpBp(1);    break;
          // Leaving replay leaves BOTH halves, so the highlight must not stay
          // on auto: the next recording starts in step mode.
          case 'exit':   a.exit(); mode = 'step'; setExpanded(false); break;
        }
      } catch (err) { /* never let the panel break the debugger */ }
      sync();
    });

    var slider = $pill.querySelector('[data-act="slider"]');
    slider.addEventListener('input', function() {
      if (!ctx || !ctx.actions) return;
      // Deliberately does NOT touch `mode`. A scrub is a seek, not a mode --
      // and the slider occupies the grid cell UNDER THE "AUTO MODE" CAPTION, so
      // setting step here lit the box on the opposite side of the panel from the
      // control being dragged. Leaving mode alone keeps the highlight truthful
      // (you are still in whichever half you were in, now paused). It still
      // stops autoplay: the timer and the drag would fight over the index.
      stopPlay();
      try { ctx.actions.stepTo(parseInt(this.value, 10) || 0); } catch (e) {}
    });


    dragging();
  }

  // Pointer drag by the grip, plus arrow keys while the grip has focus. The
  // grip is a <button> so it is reachable by Tab, and its own arrow keys are
  // stopped from bubbling -- otherwise they would reach the debugger's
  // document-level stepping handler and step the recording instead of moving
  // the panel. (Adjudicating those keys against Ace is slice 3.)
  // Pointer drag by a grip, shared by the pill's dock and the variables
  // window. `onFirstMove` lets the variables window detach itself the moment a
  // real drag starts rather than on mousedown, so a tap still means "click".
  function draggable(target, gripSel, root, onFirstMove) {
    var grip = root.querySelector(gripSel);
    if (!grip) return;
    var down = null;
    function bounds() { return $layer.getBoundingClientRect(); }
    function put(left, top) {
      var b = bounds();
      target.style.left = Math.max(4, Math.min(left, b.width - target.offsetWidth - 4)) + 'px';
      target.style.top = Math.max(4, Math.min(top, b.height - target.offsetHeight - 4)) + 'px';
    }
    grip.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var r = target.getBoundingClientRect(), b = bounds();
      down = { dx: e.clientX - r.left, dy: e.clientY - r.top, bx: b.left, by: b.top,
               sx: e.clientX, sy: e.clientY, moved: false };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      grip.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function (e) {
      if (!down) return;
      if (!down.moved && (Math.abs(e.clientX - down.sx) > 4 || Math.abs(e.clientY - down.sy) > 4)) {
        down.moved = true;
        if (onFirstMove) onFirstMove();
        var r = target.getBoundingClientRect(), b = bounds();
        down.dx = down.sx - r.left; down.dy = down.sy - r.top; down.bx = b.left; down.by = b.top;
      }
      if (down.moved) put(e.clientX - down.bx - down.dx, e.clientY - down.by - down.dy);
    });
    function end() { if (down) grip.classList.remove('dragging'); down = null; }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', function (e) {
      var map = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
      var d = map[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      if (onFirstMove) onFirstMove();
      put((parseFloat(target.style.left) || 0) + d[0], (parseFloat(target.style.top) || 0) + d[1]);
    });
  }

  function dragging() {
    var grip = $pill.querySelector('[data-grip]');
    var down = null;

    function bounds() { return $layer.getBoundingClientRect(); }
    function put(left, top) {
      var b = bounds();
      $dock.style.left = Math.max(4, Math.min(left, b.width - $pill.offsetWidth - 4)) + 'px';
      $dock.style.top  = Math.max(4, Math.min(top,  b.height - $pill.offsetHeight - 4)) + 'px';
      if (draggedSinceDown) placed = true;
      placeVars();
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
      window.addEventListener('resize', placeVars);
      // The pill's width/height are transitioned, so anything measured against
      // it has to be re-measured once the transition lands.
      $pill.addEventListener('transitionend', function (e) {
        if (e.propertyName === 'width' || e.propertyName === 'height') {
          place();
          placeVars();
        }
      });
    },
    // Called wherever the debugger's own state changes.
    sync: sync,
    afterRun: function() { stopPlay(); sync(); },
    // Editing invalidates the recording's line numbers, so a marching
    // highlight would be walking over code that no longer means anything.
    // wasReplaying is passed by pyodide.js, which has already called
    // exitReplay() by the time this runs -- so the panel cannot work out for
    // itself that there was anything to lose.
    onEditorChange: function(wasReplaying) {
      if (wasReplaying) editExited = true;
      stopPlay();
      sync();
    }
  };

})(window, document);
