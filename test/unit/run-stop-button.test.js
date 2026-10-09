'use strict';

// Page-side view of the GlowScript Stop button, against the real markup of both
// toolbars that carry a .run-it: the editor toolbar (glowscript.html) and the
// output-only toolbar (default-toolbar.html).
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { JSDOM } = require('jsdom');
const { create } = require('../../public/js/embed/run-stop-button');

const EDITOR_RUN = '<a id="editorRun" class="run-it menu-button item allow-original" data-action="code.run" data-tooltip aria-haspopup="true" title="View the result." data-options="disable_for_touch:true" data-selector="tip1"><i class="fa fa-play"></i><label class="show-for-large-up">Run</label></a>';
const OUTPUT_RUN = '<button id="outputRun" class="run-it menu-button item button allow-original" data-action="code.run" title="View the result." aria-label="Run Code" role="button" tabindex="0"><i class="fa fa-play"></i><label>Run</label></button>';

function page() {
  const dom = new JSDOM('<!doctype html><body><div class="icon-bar">' + EDITOR_RUN + OUTPUT_RUN + '</div>'
    + '<span class="tooltip" data-selector="tip1">View the result.</span>'
    + '<span class="tooltip" data-selector="other">Other</span></body>');
  const doc = dom.window.document;
  const dataCalls = [];
  const $ = (el) => ({ data: (key, value) => dataCalls.push([el.id, key, value]) });
  const view = create(doc.querySelectorAll('.run-it'), $);
  return { doc, view, dataCalls, editor: doc.getElementById('editorRun'), output: doc.getElementById('outputRun') };
}

const text = (el, sel) => el.querySelector(sel).textContent;
const iconClass = (el) => el.querySelector('i').getAttribute('class');

describe('running', () => {
  it('turns every Run control into Stop', () => {
    const { view, editor, output } = page();
    view.set('running');
    for (const el of [editor, output]) {
      expect(el.getAttribute('data-action')).toBe('code.stop');
      expect(el.getAttribute('aria-label')).toBe('Stop program');
      expect(el.getAttribute('title')).toBe('Stop the program.');
      expect(iconClass(el)).toBe('fa fa-stop');
      expect(text(el, 'label')).toBe('Stop');
      expect(el.classList.contains('run-state-running')).toBe(true);
      expect(el.hasAttribute('aria-disabled')).toBe(false);
    }
  });

  it('updates the action jQuery has cached, which is what embed.js dispatches on', () => {
    const { view, dataCalls } = page();
    view.set('running');
    expect(dataCalls).toEqual([['editorRun', 'action', 'code.stop'], ['outputRun', 'action', 'code.stop']]);
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

  it("keeps the control's width while it is Stop, and releases it on Run", () => {
    const { view, editor } = page();
    Object.defineProperty(editor, 'offsetWidth', { configurable: true, value: 88 });
    view.set('running');
    expect(editor.style.minWidth).toBe('88px');
    Object.defineProperty(editor, 'offsetWidth', { configurable: true, value: 120 });
    view.set('stopping');
    expect(editor.style.minWidth).toBe('88px');
    view.set('idle');
    expect(editor.style.minWidth).toBe('');
  });

  it("drops the control's cached Foundation tooltip so it is rebuilt from the new title", () => {
    const { doc, view } = page();
    view.set('running');
    expect(doc.querySelector('span.tooltip[data-selector="tip1"]')).toBeNull();
    expect(doc.querySelector('span.tooltip[data-selector="other"]')).not.toBeNull();
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
    const { view, editor } = page();
    view.set('running');
    view.set('stopping');
    expect(text(editor, 'label')).toBe('Stopping…');
    expect(editor.getAttribute('aria-label')).toBe('Stopping program');
    expect(editor.getAttribute('title')).toBe('Stopping the program.');
    expect(editor.getAttribute('data-action')).toBe('code.stop');
    expect(editor.getAttribute('aria-disabled')).toBe('true');
    expect(editor.classList.contains('run-state-stopping')).toBe(true);
    expect(editor.classList.contains('run-state-running')).toBe(false);
  });
});

describe('idle', () => {
  it("restores each toolbar's own original wording exactly", () => {
    const { view, editor, output } = page();
    view.set('running');
    view.set('stopping');
    view.set('idle');

    expect(editor.getAttribute('data-action')).toBe('code.run');
    expect(editor.getAttribute('title')).toBe('View the result.');
    expect(editor.hasAttribute('aria-label')).toBe(false);
    expect(text(editor, 'label')).toBe('Run');

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
