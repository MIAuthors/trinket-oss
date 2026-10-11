// Page-side view of the GlowScript Stop button: morphs the toolbar's Run
// control(s) into Stop while a program runs, dimmed while it stops, and back to
// exactly what each one was, so the editor and output-only toolbars keep their
// own wording. The control keeps the exact width it has as Run in every state, so
// nothing in the toolbar moves.
//
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md
// UMD-lite: window global for the embed page, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketRunStopButton = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Stopping shows what running shows, so the control does not change size; the
  // stylesheet dims it, and only the wording read aloud and in the tooltip says
  // that it is stopping.
  var STATES = {
    running:  { cls: 'run-state-running',  icon: 'fa fa-stop', label: 'Stop',
                aria: 'Stop program',     title: 'Stop the program.' },
    stopping: { cls: 'run-state-stopping', icon: 'fa fa-stop', label: 'Stop',
                aria: 'Stopping program', title: 'Stopping the program.' }
  };

  function setAttr(el, name, value) {
    if (value === null || value === undefined) { el.removeAttribute(name); }
    else { el.setAttribute(name, value); }
  }

  // This project's Foundation 5.5 builds a control's tooltip once, at page init,
  // from its title, blanking the title as it does, and never rebuilds one. So a
  // control with a built tooltip keeps its title as Foundation left it and the
  // view rewrites the tooltip's text in place; a control without one carries
  // the wording in its title attribute. Foundation keys a tooltip by the
  // control's id, else by the data-selector it assigns.
  function tooltipOf(el) {
    var selector = el.getAttribute('id') || el.getAttribute('data-selector');
    if (!selector) { return null; }
    return el.ownerDocument.querySelector('span.tooltip[data-selector="' + selector + '"]');
  }

  // A tooltip is its text followed by Foundation's .nub (and, on touch devices,
  // a .tap-to-close); only the text in front of the nub is the wording.
  function isNub(node) {
    return node.nodeType === 1 && node.classList.contains('nub');
  }

  function tooltipText(tip) {
    var text = '';
    for (var node = tip.firstChild; node && !isNub(node); node = node.nextSibling) {
      text += node.textContent;
    }
    return text;
  }

  function setTooltipText(tip, text) {
    var nub = null;
    for (var node = tip.firstChild; node; node = node.nextSibling) {
      if (isNub(node)) { nub = node; break; }
    }
    while (tip.firstChild && tip.firstChild !== nub) { tip.removeChild(tip.firstChild); }
    tip.insertBefore(tip.ownerDocument.createTextNode(text || ''), nub);
  }

  function setTitle(el, title) {
    var tip = tooltipOf(el);
    if (tip) { setTooltipText(tip, title); }
    else { setAttr(el, 'title', title); }
  }

  function snapshot(el) {
    var icon = el.querySelector('i');
    var label = el.querySelector('label');
    var tip = tooltipOf(el);
    return {
      action: el.getAttribute('data-action'),
      // The wording to restore: a built tooltip's text, else the title.
      title: tip ? tooltipText(tip) : el.getAttribute('title'),
      aria: el.getAttribute('aria-label'),
      icon: icon ? icon.getAttribute('class') : null,
      label: label ? label.textContent : null,
      // The inline size and wrapping the markup itself carries, if any (usually
      // none), restored when the program ends: the width hold below overrides
      // width, padding and white-space while a program runs. It never writes
      // min-width; that is captured and restored defensively, in case markup
      // or an older view left one.
      width: el.style.width,
      minWidth: el.style.minWidth,
      paddingLeft: el.style.paddingLeft,
      paddingRight: el.style.paddingRight,
      whiteSpace: el.style.whiteSpace
    };
  }

  // The strip that laps the control's inside edge while a program runs.
  function addTrace(el) {
    if (el.querySelector('.run-stop-trace')) { return; }
    var doc = el.ownerDocument;
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'run-stop-trace');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('rx', '3');
    rect.setAttribute('pathLength', '100');
    svg.appendChild(rect);
    el.appendChild(svg);
  }

  function px(value) { return parseFloat(value) || 0; }

  // Holds the control at runWidth, the outer width it measured as Run, now that it
  // shows Stop. Stop's icon and label come out a few pixels wider than Run's (about
  // 4 px, or 1 px where only the icon shows), so the difference comes out of the
  // control's own side padding, half from each side, which keeps the content
  // centered. A control that Stop fits in is only held. The caller has swapped in
  // Stop's content and nothing here has overridden the size yet, so the width read
  // now is Stop's natural one. Sub-pixel widths are kept: rounding them moves the
  // toolbar by a pixel.
  function holdWidth(el, runWidth) {
    var stopWidth = el.getBoundingClientRect().width;
    // Live: it follows the inline style below, so everything is read before any write.
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    var squeeze = Math.max(0, stopWidth - runWidth) / 2;
    var left = Math.max(0, px(style.paddingLeft) - squeeze);
    var right = Math.max(0, px(style.paddingRight) - squeeze);
    // Foundation 5 gives every element border-box, where width is the outer width.
    // A content-box control's width leaves out its padding and border.
    var width = runWidth;
    if (style.boxSizing === 'content-box') {
      width = Math.max(0, runWidth - left - right - px(style.borderLeftWidth) - px(style.borderRightWidth));
    }
    if (squeeze > 0) {
      el.style.paddingLeft = left + 'px';
      el.style.paddingRight = right + 'px';
    }
    el.style.width = width + 'px';
    // The fit is exact, and a layout engine that rounds a length to its grid (1/64 px
    // in Blink and WebKit, 1/60 px in Gecko) can leave the content box one step short
    // of Stop's content. Then the label drops under the icon and the control grows
    // 16 px taller. One line it stays: a shortfall overflows by a step, unseen.
    el.style.whiteSpace = 'nowrap';
  }

  function setAction(el, action, $) {
    setAttr(el, 'data-action', action);
    // embed.js dispatches on jQuery's .data('action'), which caches the first read.
    if ($) { $(el).data('action', action); }
  }

  function create(elements, $) {
    var items = Array.prototype.map.call(elements, function (el) {
      return { el: el, orig: snapshot(el) };
    });
    var current = 'idle';

    function apply(item, next) {
      var el = item.el;
      var orig = item.orig;
      var icon = el.querySelector('i');
      var label = el.querySelector('label');
      // Leaving idle: the control exactly as it shows Run, before anything below
      // changes it. Running and stopping are the same size, so they never measure.
      var runWidth = current === 'idle' && next !== 'idle' ? el.getBoundingClientRect().width : 0;

      el.classList.remove('run-state-running', 'run-state-stopping');

      if (next === 'idle') {
        setAction(el, orig.action, $);
        setTitle(el, orig.title);
        setAttr(el, 'aria-label', orig.aria);
        el.removeAttribute('aria-disabled');
        if (icon) { setAttr(icon, 'class', orig.icon); }
        if (label) { label.textContent = orig.label; }
        el.style.width = orig.width;
        el.style.minWidth = orig.minWidth;
        el.style.paddingLeft = orig.paddingLeft;
        el.style.paddingRight = orig.paddingRight;
        el.style.whiteSpace = orig.whiteSpace;
      } else {
        var s = STATES[next];
        addTrace(el);
        el.classList.add(s.cls);
        setAction(el, 'code.stop', $);
        setTitle(el, s.title);
        setAttr(el, 'aria-label', s.aria);
        if (next === 'stopping') { el.setAttribute('aria-disabled', 'true'); }
        else { el.removeAttribute('aria-disabled'); }
        if (icon) { icon.setAttribute('class', s.icon); }
        if (label) { label.textContent = s.label; }
        // A control that is not rendered (a hidden toolbar) has no width to keep.
        if (runWidth > 0) { holdWidth(el, runWidth); }
      }
    }

    return {
      set: function (next) {
        if (next !== 'idle' && !STATES[next]) { throw new Error('unknown run state: ' + next); }
        items.forEach(function (item) { apply(item, next); });
        current = next;
      },
      state: function () { return current; }
    };
  }

  return { create: create };
}));
