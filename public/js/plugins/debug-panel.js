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
  var open    = true;

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
  // Colours are the debugger's own literals, not new ones: #2b6c9e is
  // .debug-btn and #14435f its hover (lib/views/embed/pyodide.html), #a94442 is
  // .debug-bp-btn. Trinket has no dark mode and no CSS custom properties, so
  // everything here is a literal light value on purpose.
  //
  // z-index 1200 is a chosen number, not a large one: it has to clear
  // .alert-box (999) and .tab-options.open (1000), and it must stay well under
  // plotpolish's pill (2147483000, inside a shadow root) so that when both
  // features are on the plot-style pill still wins its own corner.
  var CSS = [
    '.tk-dbg-layer{position:absolute;inset:0;pointer-events:none;z-index:1200}',
    '.tk-dbg{position:absolute;display:flex;align-items:stretch;pointer-events:auto;',
      'background:#e7f0f7;border:1px solid #b9d0e2;border-radius:999px;',
      'box-shadow:0 4px 14px rgba(0,0,0,.22);font-size:13px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'max-width:calc(100% - 16px);transition:box-shadow 140ms ease}',
    '.tk-dbg.dragging{box-shadow:0 10px 28px rgba(0,0,0,.28);transition:none}',
    '.tk-dbg[hidden]{display:none!important}',
    '.tk-dbg-grip{display:flex;align-items:center;gap:2px;padding:0 5px 0 8px;',
      'cursor:grab;border-radius:999px 0 0 999px;flex:0 0 auto;background:none;border:0}',
    '.tk-dbg.dragging .tk-dbg-grip{cursor:grabbing}',
    '.tk-dbg-grip span{display:flex;flex-direction:column;gap:2px}',
    '.tk-dbg-grip i{width:3px;height:3px;border-radius:50%;background:#6d8ea8;display:block}',
    '.tk-dbg-toggle{display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:1px;border:0;background:none;cursor:pointer;color:#2b6c9e;',
      'padding:3px 9px 3px 3px;border-radius:0 999px 999px 0;flex:0 0 auto;line-height:1}',
    '.tk-dbg.open .tk-dbg-toggle{border-radius:0;border-right:1px solid #c3d6e5;padding-right:8px}',
    '.tk-dbg-toggle:hover{color:#14435f}',
    '.tk-dbg-toggle .w{font-size:8.5px;font-weight:700;letter-spacing:.13em}',
    '.tk-dbg-toggle .fa{font-size:14px}',
    '.tk-dbg-body{display:none;align-items:center;gap:1px;padding:0 6px 0 6px;min-width:0}',
    /* Groups lay themselves out with flex, so `hidden` has to beat that: the
       attribute alone carries only UA-level display:none, which any stylesheet
       rule outranks -- an inline display:flex here would never hide. */
    '.tk-dbg [data-grp]{display:flex;align-items:center;gap:1px}',
    '.tk-dbg [data-grp][hidden]{display:none!important}',
    '.tk-dbg.open .tk-dbg-body{display:flex}',
    '.tk-dbg-btn{border:0;background:none;cursor:pointer;color:#2b6c9e;padding:4px;',
      'line-height:1;border-radius:4px;flex:0 0 auto;font-size:13px}',
    '.tk-dbg-btn:hover:not(:disabled){color:#14435f;background:#d9e8f3}',
    '.tk-dbg-btn:disabled{opacity:.38;cursor:default}',
    '.tk-dbg-btn.bp{color:#a94442}',
    '.tk-dbg-slider{width:112px;margin:0 4px;accent-color:#2b6c9e;height:14px;flex:0 0 auto}',
    '.tk-dbg-pos{font-family:monospace;font-size:10.5px;color:#14435f;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;padding:0 3px}',
    '.tk-dbg-note{font-size:10.5px;color:#b06000;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;max-width:190px;padding:0 4px}',
    '.tk-dbg-sep{width:1px;align-self:stretch;background:#c3d6e5;margin:4px 3px;flex:0 0 auto}',
    '.tk-dbg :focus-visible{outline:2px solid #2b6c9e;outline-offset:1px}',
    '@media (prefers-reduced-motion: reduce){.tk-dbg{transition:none}}'
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
    + '<button type="button" class="tk-dbg-toggle" data-act="toggle" aria-expanded="true"'
    +   ' title="Step through this program line by line">'
    +   '<span class="w">DEBUG</span><i class="fa fa-bug" aria-hidden="true"></i>'
    + '</button>'
    + '<span class="tk-dbg-body">'
    +   '<span data-grp="launch">'
    +     btn('start', 'fa-step-forward', 'Records your program running from scratch, then lets you step through it')
    +   '</span>'
    +   '<span data-grp="recording" hidden>'
    +     btn('cancel', 'fa-times', 'Cancel the recording')
    +   '</span>'
    +   '<span data-grp="controls" hidden>'
    +     btn('first', 'fa-fast-backward', 'First step')
    +     btn('back', 'fa-step-backward', 'Previous step')
    +     '<input type="range" class="tk-dbg-slider" data-act="slider" min="0" max="0" value="0"'
    +       ' aria-label="Step position">'
    +     '<span class="tk-dbg-pos" data-el="pos">0 / 0</span>'
    +     btn('fwd', 'fa-step-forward', 'Next step')
    +     btn('last', 'fa-fast-forward', 'Last step')
    +     '<span class="tk-dbg-sep"></span>'
    +     btn('prevbp', 'fa-chevron-circle-left', 'Previous breakpoint', 'bp')
    +     btn('nextbp', 'fa-chevron-circle-right', 'Next breakpoint', 'bp')
    +     '<span class="tk-dbg-note" data-el="note"></span>'
    +     btn('exit', 'fa-times', 'Exit step-through')
    +   '</span>'
    + '</span>';

  function mount() {
    if (mounted) return;
    injectCss();
    $layer = document.createElement('div');
    $layer.className = 'tk-dbg-layer';
    $pill = document.createElement('div');
    $pill.className = 'tk-dbg open';
    $pill.setAttribute('role', 'group');
    $pill.setAttribute('aria-label', 'Step-through debugger');
    $pill.innerHTML = MARKUP;
    $pill.hidden = true;
    $layer.appendChild($pill);
    layerHost().appendChild($layer);
    wire();
    mounted = true;
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
    var nav = document.querySelector('#editor .tab-nav');
    var tabs = document.querySelector('#editor .tab-nav .scrollable-content');
    var host = $layer.getBoundingClientRect();
    if (!nav || !host.width) return;
    var nr = nav.getBoundingClientRect();
    var tr = tabs ? tabs.getBoundingClientRect() : null;
    var left = (tr && tr.width ? tr.right : nr.left + 120) - host.left + 10;
    var top = nr.top - host.top + 2;
    var maxLeft = host.width - $pill.offsetWidth - 6;
    $pill.style.left = Math.max(6, Math.min(left, maxLeft)) + 'px';
    $pill.style.top = Math.max(2, top) + 'px';
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
      $pill.querySelector('[data-act="back"]').disabled = s.idx <= 0;
      $pill.querySelector('[data-act="fwd"]').disabled = s.idx >= s.total;
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
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || b.tagName === 'INPUT') return;
      var act = b.getAttribute('data-act');
      if (act === 'toggle') {
        open = !open;
        $pill.classList.toggle('open', open);
        b.setAttribute('aria-expanded', String(open));
        place();
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
      placed = true;
    }

    grip.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      var pr = $pill.getBoundingClientRect(), b = bounds();
      down = { dx: e.clientX - pr.left, dy: e.clientY - pr.top, bx: b.left, by: b.top };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      $pill.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function(e) {
      if (!down) return;
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
