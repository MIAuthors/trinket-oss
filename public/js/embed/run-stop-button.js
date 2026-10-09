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

  function snapshot(el) {
    var icon = el.querySelector('i');
    var label = el.querySelector('label');
    return {
      action: el.getAttribute('data-action'),
      title: el.getAttribute('title'),
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

  // Foundation builds a control's tooltip lazily from its title and caches it;
  // drop the cached one so the next hover rebuilds it from the new title.
  function dropTooltip(el) {
    var selector = el.getAttribute('data-selector');
    if (!selector) { return; }
    var tips = el.ownerDocument.querySelectorAll('span.tooltip[data-selector="' + selector + '"]');
    Array.prototype.forEach.call(tips, function (tip) { tip.parentNode.removeChild(tip); });
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
        setAttr(el, 'title', orig.title);
        setAttr(el, 'aria-label', orig.aria);
        el.removeAttribute('aria-disabled');
        if (icon) { setAttr(icon, 'class', orig.icon); }
        if (label) { label.textContent = orig.label; }
        el.style.minWidth = '';
      } else {
        var s = STATES[next];
        // Keep Run's width so the toolbar does not shift between Run, Stop and Stopping….
        if (current === 'idle') { el.style.minWidth = el.offsetWidth ? el.offsetWidth + 'px' : ''; }
        addTrace(el);
        el.classList.add(s.cls);
        setAction(el, 'code.stop', $);
        setAttr(el, 'title', s.title);
        setAttr(el, 'aria-label', s.aria);
        if (next === 'stopping') { el.setAttribute('aria-disabled', 'true'); }
        else { el.removeAttribute('aria-disabled'); }
        if (icon) { icon.setAttribute('class', s.icon); }
        if (label) { label.textContent = s.label; }
      }

      dropTooltip(el);
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
