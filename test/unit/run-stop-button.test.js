'use strict';

// Page-side view of the GlowScript Stop button, against the real markup of both
// toolbars that carry a .run-it: the editor toolbar (glowscript.html) as
// Foundation leaves it after building its tooltip (wording moved into a
// span.tooltip keyed by the control's data-selector, title blanked), and the
// output-only toolbar (default-toolbar.html), which has no tooltip.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { JSDOM } = require('jsdom');
const { create } = require('../../public/js/embed/run-stop-button');

const EDITOR_RUN = '<a class="run-it menu-button item allow-original" data-action="code.run" data-tooltip aria-haspopup="true" title="" data-options="disable_for_touch:true" data-selector="tip1" aria-describedby="tip1"><i class="fa fa-play"></i><label class="show-for-large-up">Run</label></a>';
const EDITOR_TIP = '<span data-selector="tip1" id="tip1" class="tooltip" role="tooltip">View the result.<span class="nub"></span></span>';
const OTHER_TIP = '<span data-selector="other" id="other" class="tooltip" role="tooltip">Other<span class="nub"></span></span>';
const OUTPUT_RUN = '<button id="outputRun" class="run-it menu-button item button allow-original" data-action="code.run" title="View the result." aria-label="Run Code" role="button" tabindex="0"><i class="fa fa-play"></i><label>Run</label></button>';

function page() {
  const dom = new JSDOM('<!doctype html><body><div class="icon-bar">' + EDITOR_RUN + OUTPUT_RUN + '</div>'
    + EDITOR_TIP + OTHER_TIP + '</body>');
  const doc = dom.window.document;
  const dataCalls = [];
  const key = (el) => el.id || el.getAttribute('data-selector');
  const $ = (el) => ({ data: (name, value) => dataCalls.push([key(el), name, value]) });
  const view = create(doc.querySelectorAll('.run-it'), $);
  return {
    doc, view, dataCalls,
    editor: doc.querySelector('.run-it[data-selector="tip1"]'),
    output: doc.getElementById('outputRun'),
    tip: doc.getElementById('tip1'),
  };
}

const text = (el, sel) => el.querySelector(sel).textContent;
const iconClass = (el) => el.querySelector('i').getAttribute('class');
const tipText = (tip) => tip.firstChild.textContent;
const lastAction = (dataCalls, id) => dataCalls.filter((c) => c[0] === id).pop()[2];

describe('running', () => {
  it('turns every Run control into Stop', () => {
    const { view, editor, output } = page();
    view.set('running');
    for (const el of [editor, output]) {
      expect(el.getAttribute('data-action')).toBe('code.stop');
      expect(el.getAttribute('aria-label')).toBe('Stop program');
      expect(iconClass(el)).toBe('fa fa-stop');
      expect(text(el, 'label')).toBe('Stop');
      expect(el.classList.contains('run-state-running')).toBe(true);
      expect(el.hasAttribute('aria-disabled')).toBe(false);
    }
    expect(output.getAttribute('title')).toBe('Stop the program.');
  });

  it("rewrites a Foundation tooltip's text in place and leaves the title Foundation blanked", () => {
    const { doc, view, editor, tip } = page();
    view.set('running');
    expect(tipText(tip)).toBe('Stop the program.');
    expect(tip.querySelector('.nub')).not.toBeNull();
    expect(editor.getAttribute('title')).toBe('');
    expect(doc.getElementById('other').firstChild.textContent).toBe('Other');
  });

  it('follows a tooltip Foundation builds after the view was created', () => {
    const dom = new JSDOM('<!doctype html><body><a class="run-it" data-action="code.run" title="View the result."><i class="fa fa-play"></i><label>Run</label></a></body>');
    const doc = dom.window.document;
    const el = doc.querySelector('.run-it');
    const view = create(doc.querySelectorAll('.run-it'));
    // What Foundation's tooltip init does: move the title into a tip, then blank the title.
    el.setAttribute('data-selector', 'late');
    el.setAttribute('title', '');
    doc.body.insertAdjacentHTML('beforeend', '<span data-selector="late" id="late" class="tooltip" role="tooltip">View the result.<span class="nub"></span></span>');
    const tip = doc.getElementById('late');
    view.set('running');
    expect(tipText(tip)).toBe('Stop the program.');
    expect(el.getAttribute('title')).toBe('');
    view.set('idle');
    expect(tipText(tip)).toBe('View the result.');
  });

  it('updates the action jQuery has cached, which is what embed.js dispatches on, both ways', () => {
    const { view, dataCalls } = page();
    view.set('running');
    expect(lastAction(dataCalls, 'tip1')).toBe('code.stop');
    expect(lastAction(dataCalls, 'outputRun')).toBe('code.stop');
    view.set('idle');
    expect(lastAction(dataCalls, 'tip1')).toBe('code.run');
    expect(lastAction(dataCalls, 'outputRun')).toBe('code.run');
  });

  it('injects one decorative strip per control, however often it runs', () => {
    const { view, editor } = page();
    view.set('running');
    view.set('idle');
    view.set('running');
    const traces = editor.querySelectorAll('svg.run-stop-trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].getAttribute('aria-hidden')).toBe('true');
    const rect = traces[0].querySelector('rect');
    expect(rect.getAttribute('pathLength')).toBe('100');
    expect(rect.getAttribute('width')).toBe('100%');
    expect(rect.getAttribute('height')).toBe('100%');
    expect(rect.getAttribute('rx')).toBe('3');
  });

  it('keeps the control as wide as its widest label while it is Stop, and releases it on Run', () => {
    const { view, editor } = page();
    // A stand-in for layout: 40 px of padding and icon plus 7 px per label character.
    Object.defineProperty(editor, 'offsetWidth', {
      configurable: true,
      get: () => 40 + 7 * editor.querySelector('label').textContent.length,
    });
    const widest = (40 + 7 * 'Stopping…'.length) + 'px';
    view.set('running');
    expect(editor.style.minWidth).toBe(widest);
    expect(text(editor, 'label')).toBe('Stop');
    view.set('stopping');
    expect(editor.style.minWidth).toBe(widest);
    view.set('idle');
    expect(editor.style.minWidth).toBe('');
  });

  it('keeps keyboard focus on the same control', () => {
    const { doc, view, output } = page();
    output.focus();
    view.set('running');
    expect(doc.activeElement).toBe(output);
    view.set('idle');
    expect(doc.activeElement).toBe(output);
  });
});

describe('stopping', () => {
  it('shows Stopping…, still routes to code.stop, and is marked disabled for assistive tech', () => {
    const { view, editor, output, tip } = page();
    view.set('running');
    view.set('stopping');
    expect(text(editor, 'label')).toBe('Stopping…');
    expect(editor.getAttribute('aria-label')).toBe('Stopping program');
    expect(tipText(tip)).toBe('Stopping the program.');
    expect(output.getAttribute('title')).toBe('Stopping the program.');
    expect(editor.getAttribute('data-action')).toBe('code.stop');
    expect(editor.getAttribute('aria-disabled')).toBe('true');
    expect(editor.classList.contains('run-state-stopping')).toBe(true);
    expect(editor.classList.contains('run-state-running')).toBe(false);
  });

  it('a new run while stopping is Stop again and no longer disabled', () => {
    const { view, editor } = page();
    view.set('running');
    view.set('stopping');
    view.set('running');
    expect(text(editor, 'label')).toBe('Stop');
    expect(editor.hasAttribute('aria-disabled')).toBe(false);
    expect(editor.classList.contains('run-state-running')).toBe(true);
    expect(editor.classList.contains('run-state-stopping')).toBe(false);
  });
});

describe('idle', () => {
  it("restores each toolbar's own original wording exactly", () => {
    const { view, editor, output, tip } = page();
    view.set('running');
    view.set('stopping');
    view.set('idle');

    expect(editor.getAttribute('data-action')).toBe('code.run');
    expect(editor.getAttribute('title')).toBe('');
    expect(tipText(tip)).toBe('View the result.');
    expect(editor.hasAttribute('aria-label')).toBe(false);
    expect(text(editor, 'label')).toBe('Run');

    expect(output.getAttribute('title')).toBe('View the result.');
    expect(output.getAttribute('aria-label')).toBe('Run Code');
    expect(text(output, 'label')).toBe('Run');

    for (const el of [editor, output]) {
      expect(iconClass(el)).toBe('fa fa-play');
      expect(el.hasAttribute('aria-disabled')).toBe(false);
      expect(el.classList.contains('run-state-running')).toBe(false);
      expect(el.classList.contains('run-state-stopping')).toBe(false);
    }
  });
});

describe('robustness', () => {
  it('rejects an unknown state', () => {
    const { view } = page();
    expect(() => view.set('paused')).toThrow(/unknown run state/);
  });

  it('copes with a control that has no icon or label', () => {
    const dom = new JSDOM('<a class="run-it" data-action="code.run">Run</a>');
    const view = create(dom.window.document.querySelectorAll('.run-it'));
    expect(() => { view.set('running'); view.set('idle'); }).not.toThrow();
  });

  it('reports its state', () => {
    const { view } = page();
    expect(view.state()).toBe('idle');
    view.set('running');
    expect(view.state()).toBe('running');
  });
});
