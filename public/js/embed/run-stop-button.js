// Page-side view of the GlowScript Stop button: morphs the toolbar's Run
// control(s) between Run, Stop and Stopping…, and back to exactly what each
// one was, so the editor and output-only toolbars keep their own wording.
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
  var STATES = {
    running:  { cls: 'run-state-running',  icon: 'fa fa-stop', label: 'Stop',
                aria: 'Stop program',     title: 'Stop the program.' },
    stopping: { cls: 'run-state-stopping', icon: 'fa fa-stop', label: 'Stopping…',
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
      label: label ? label.textContent : null
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

  // The control's width with its widest label (Run, Stop or Stopping…), so the
  // toolbar does not shift as the label changes.
  function widestWidth(el, label, texts) {
    if (!label) { return el.offsetWidth; }
    var saved = label.textContent;
    var widest = 0;
    texts.forEach(function (text) {
      label.textContent = text;
      widest = Math.max(widest, el.offsetWidth);
    });
    label.textContent = saved;
    return widest;
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

      el.classList.remove('run-state-running', 'run-state-stopping');

      if (next === 'idle') {
        setAction(el, orig.action, $);
        setTitle(el, orig.title);
        setAttr(el, 'aria-label', orig.aria);
        el.removeAttribute('aria-disabled');
        if (icon) { setAttr(icon, 'class', orig.icon); }
        if (label) { label.textContent = orig.label; }
        el.style.minWidth = '';
      } else {
        var s = STATES[next];
        if (current === 'idle') {
          var widest = widestWidth(el, label, [orig.label, STATES.running.label, STATES.stopping.label]);
          el.style.minWidth = widest ? widest + 'px' : '';
        }
        addTrace(el);
        el.classList.add(s.cls);
        setAction(el, 'code.stop', $);
        setTitle(el, s.title);
        setAttr(el, 'aria-label', s.aria);
        if (next === 'stopping') { el.setAttribute('aria-disabled', 'true'); }
        else { el.removeAttribute('aria-disabled'); }
        if (icon) { icon.setAttribute('class', s.icon); }
        if (label) { label.textContent = s.label; }
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
