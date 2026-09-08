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
    '.tk-dbg button,.tk-dbg input{margin:0}',
    '.tk-dbg{position:absolute;display:flex;align-items:center;pointer-events:auto;',
      'background:#ffffff;border:0;border-radius:999px;',
      // The "outline" is the shadow's own hairline ring, not a border: a 1px
      // border plus a shadow reads as two edges at this radius.
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 3px 12px rgba(31,35,40,.18);',
      'width:72px;height:32px;overflow:hidden;font-size:13px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'user-select:none;-webkit-user-select:none;',
      'transition:width 170ms cubic-bezier(.2,.7,.3,1),height 170ms cubic-bezier(.2,.7,.3,1),box-shadow 140ms ease}',
    // Only the two axes change on open; the ring must survive both states.
    '.tk-dbg.open{width:322px;height:66px;max-width:calc(100% - 16px)}',
    '.tk-dbg.dragging{box-shadow:0 0 0 1px rgba(31,35,40,.18), 0 10px 26px rgba(31,35,40,.3);transition:none}',
    '.tk-dbg:not(.open){cursor:pointer}',
    '.tk-dbg[hidden]{display:none!important}',
    // align-self:center rather than the pill's stretch, so the dots sit on the
    // pill's vertical midline whatever height it is at.
    '.tk-dbg-grip{display:flex;align-items:center;gap:2px;padding:0 5px 0 8px;',
      'cursor:grab;border-radius:999px 0 0 999px;flex:0 0 auto;background:none;border:0}',
    '.tk-dbg.dragging .tk-dbg-grip{cursor:grabbing}',
    '.tk-dbg-grip span{display:flex;flex-direction:column;gap:2px}',
    '.tk-dbg-grip i{width:3px;height:3px;border-radius:50%;background:#59636e;display:block}',
    // Fills the pill's height rather than sitting in a box inside it: the
    // label takes only the space its 8px caps need, and the glyph gets the
    // rest via flex:1. Backgrounds stay transparent in every state except a
    // faint hover tint -- a filled rectangle inside a rounded pill reads as a
    // second object, which is exactly what it looked like.
    '.tk-dbg-toggle{display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:1px;border:0;background:none;cursor:pointer;',
      'color:#0969da;padding:0 10px 0 4px;border-radius:0 999px 999px 0;',
      'flex:0 0 auto;line-height:1}',
    '.tk-dbg.open .tk-dbg-toggle{border-radius:0;border-right:1px solid #c3d9ef;padding-right:9px}',
    '.tk-dbg-toggle:hover{color:#0550ae;background:rgba(9,105,218,.09)}',
    '.tk-dbg-toggle .w{font-size:8px;font-weight:700;letter-spacing:.14em;line-height:1}',
    // flex:1 + a line-height of 1 lets the glyph occupy the whole remaining
    // height; font-size then sets how much of that it actually inks.
    '.tk-dbg-toggle .fa{display:block;font-size:17px;line-height:1}',
    '.tk-dbg-body{display:none;flex-direction:column;justify-content:center;',
      'gap:2px;padding:0 8px 0 6px;min-width:0;flex:1}',
    '.tk-dbg.open .tk-dbg-body{display:flex}',
    // Row 1 transport + jumps + exit; row 2 the slider and its counter.
    '.tk-dbg-row{display:flex;align-items:center;gap:1px;min-width:0}',
    '.tk-dbg-row.two{gap:5px}',
    /* Groups lay themselves out with flex, so `hidden` has to beat that: the
       attribute alone carries only UA-level display:none, which any stylesheet
       rule outranks -- an inline display:flex here would never hide. */
    '.tk-dbg [data-grp]{display:flex;align-items:center;gap:1px}',
    '.tk-dbg [data-grp][hidden]{display:none!important}',
    '.tk-dbg [data-grp="controls"]{flex-direction:column;align-items:stretch;',
      'gap:3px;flex:1;min-width:0}',
    '.tk-dbg-btn{border:0;background:none;cursor:pointer;color:#0969da;padding:4px;',
      'line-height:1;border-radius:4px;flex:0 0 auto;font-size:13px}',
    '.tk-dbg-btn:hover:not(:disabled){color:#0550ae;background:rgba(9,105,218,.11)}',
    '.tk-dbg-btn:disabled{opacity:.38;cursor:default}',
    '.tk-dbg-btn.bp{color:#cf222e}',
    '.tk-dbg-slider{flex:1;min-width:0;margin:0;accent-color:#0969da;height:14px}',
    '.tk-dbg-pos{font-family:monospace;font-size:10.5px;color:#1f2328;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;padding:0 3px}',
    '.tk-dbg-note{font-size:10px;color:#59636e;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;flex:1;min-width:0}',
    '.tk-dbg-recording{font-size:11px;color:#59636e;white-space:nowrap}',
    '.tk-dbg-sep{width:1px;align-self:stretch;background:#c3d9ef;margin:5px 3px;flex:0 0 auto}',
    '.tk-dbg :focus-visible{outline:2px solid #0969da;outline-offset:1px}',
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
    +       btn('fwd', 'fa-step-forward', 'Next step')
    +       btn('last', 'fa-fast-forward', 'Last step')
    +       '<span class="tk-dbg-sep"></span>'
    +       btn('prevbp', 'fa-chevron-circle-left', 'Previous breakpoint', 'bp')
    +       btn('nextbp', 'fa-chevron-circle-right', 'Next breakpoint', 'bp')
    +       '<span class="tk-dbg-sep"></span>'
    +       btn('exit', 'fa-times', 'Exit step-through')
    +     '</span>'
    +     '<span class="tk-dbg-row two">'
    +       '<input type="range" class="tk-dbg-slider" data-act="slider" min="0" max="0" value="0"'
    +         ' aria-label="Step position">'
    +       '<span class="tk-dbg-pos" data-el="pos">0 / 0</span>'
    +       '<span class="tk-dbg-note" data-el="note"></span>'
    +     '</span>'
    +   '</span>'
    + '</span>';

  function mount() {
    if (mounted) return;
    injectCss();
    $layer = document.createElement('div');
    $layer.className = 'tk-dbg-layer';
    $pill = document.createElement('div');
    $pill.className = 'tk-dbg';
    $pill.setAttribute('role', 'group');
    $pill.setAttribute('aria-label', 'Step-through debugger');
    $pill.innerHTML = MARKUP;
    $pill.hidden = true;
    $layer.appendChild($pill);
    layerHost().appendChild($layer);
    wire();
    mounted = true;
  }

  var draggedSinceDown = false;

  // Opening the pill IS the request to step through -- the student should not
  // have to find a second button after it expands. Only when nothing is in
  // flight: re-expanding mid-replay must not throw the recording away, and
  // re-expanding after a deliberate exit leaves the launch button to click.
  function setExpanded(on, alsoRecord) {
    expanded = on;
    $pill.classList.toggle('open', on);
    var t = $pill.querySelector('[data-act="toggle"]');
    if (t) t.setAttribute('aria-expanded', String(on));
    place();
    if (!on || !alsoRecord || !ctx || !ctx.actions) return;
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { return; }
    if (s.recording || s.replaying) return;
    // After the class is on, so the expand animation and the (blocking, on
    // the main thread) recording do not fight for the same frame.
    window.requestAnimationFrame(function() {
      try { ctx.actions.start(); } catch (e) {}
      sync();
    });
  }

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
      if (placeTries++ < 40) window.requestAnimationFrame(place);
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
    var maxLeft = rightBound - host.left - $pill.offsetWidth;
    var x = Math.max(6, Math.min(left, maxLeft));
    var y = Math.max(2, nr.top - host.top + 2);
    $pill.style.left = x + 'px';
    $pill.style.top = y + 'px';

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
      window.requestAnimationFrame(place);
    }
  }

  // ---------------------------------------------------------------------
  // Paint from the debugger's own state -- this file owns no debugger state
  // ---------------------------------------------------------------------
  function sync() {
    if (!ctx || !mounted) return;
    var avail = false;
    try { avail = !!ctx.isAvailable(); } catch (e) { avail = false; }
    $pill.hidden = !avail;
    if (!avail) return;

    var s;
    try { s = ctx.getState() || {}; } catch (e) { return; }

    grp('launch').hidden     = s.recording || s.replaying;
    grp('recording').hidden  = !s.recording;
    grp('controls').hidden   = !s.replaying;

    if (s.replaying) {
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
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || b.tagName === 'INPUT') return;
      var act = b.getAttribute('data-act');
      if (act === 'toggle') {
        setExpanded(!expanded);
        return;
      }
      var a = ctx && ctx.actions;
      if (!a) return;
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
          case 'exit':   a.exit();       break;
        }
      } catch (err) { /* never let the panel break the debugger */ }
      sync();
    });

    var slider = $pill.querySelector('[data-act="slider"]');
    slider.addEventListener('input', function() {
      if (!ctx || !ctx.actions) return;
      try { ctx.actions.stepTo(parseInt(this.value, 10) || 0); } catch (e) {}
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
      $pill.style.left = Math.max(4, Math.min(left, b.width - $pill.offsetWidth - 4)) + 'px';
      $pill.style.top  = Math.max(4, Math.min(top,  b.height - $pill.offsetHeight - 4)) + 'px';
      if (draggedSinceDown) placed = true;
    }

    grip.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      draggedSinceDown = false;
      var pr = $pill.getBoundingClientRect(), b = bounds();
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
      put((parseFloat($pill.style.left) || 0) + d[0], (parseFloat($pill.style.top) || 0) + d[1]);
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
    afterRun: function() { sync(); },
    onEditorChange: function() { sync(); }
  };

})(window, document);
