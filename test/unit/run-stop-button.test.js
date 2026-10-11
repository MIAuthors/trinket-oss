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

// editorStyle: an inline style attribute on the editor's control, as markup may carry.
function page({ editorStyle = '' } = {}) {
  const editorRun = editorStyle
    ? EDITOR_RUN.replace('<a class="run-it', '<a style="' + editorStyle + '" class="run-it')
    : EDITOR_RUN;
  const dom = new JSDOM('<!doctype html><body><div class="icon-bar">' + editorRun + OUTPUT_RUN + '</div>'
    + EDITOR_TIP + OTHER_TIP + '</body>');
  const doc = dom.window.document;
  const dataCalls = [];
  const key = (el) => el.id || el.getAttribute('data-selector');
  const $ = (el) => ({ data: (name, value) => dataCalls.push([key(el), name, value]) });
  const view = create(doc.querySelectorAll('.run-it'), $);
  return {
    doc, view, dataCalls,
    win: dom.window,
    editor: doc.querySelector('.run-it[data-selector="tip1"]'),
    output: doc.getElementById('outputRun'),
    tip: doc.getElementById('tip1'),
  };
}

const text = (el, sel) => el.querySelector(sel).textContent;
const iconClass = (el) => el.querySelector('i').getAttribute('class');
const tipText = (tip) => tip.firstChild.textContent;
const lastAction = (dataCalls, id) => dataCalls.filter((c) => c[0] === id).pop()[2];

// jsdom does no layout, so a test says what a browser would measure. A control is
// as wide as its inline width when it has one, else as wide as its label's natural
// width: what its icon, label and padding come to, per control because the two
// toolbars' controls need not be equally wide. Its padding is the stylesheet's
// unless its own inline style sets it. As in a browser, the computed style is
// live: it reads the inline style as it is when asked.
const SHEET = { boxSizing: 'border-box', borderLeftWidth: '0px', borderRightWidth: '0px', padding: '16px' };
const RUN_STOP = { Run: 76.4, Stop: 80.4 };   // Stop 4 px wider, near enough what a 1280 px viewport gives

function layOut(p, natural = {}, sheet = SHEET) {
  const widths = { editor: RUN_STOP, output: RUN_STOP, ...natural };
  for (const name of ['editor', 'output']) {
    const el = p[name];
    el.getBoundingClientRect = vi.fn(() => {
      const locked = parseFloat(el.style.width);
      return { width: Number.isNaN(locked) ? widths[name][text(el, 'label')] : locked };
    });
  }
  p.win.getComputedStyle = (el) => ({
    boxSizing: sheet.boxSizing,
    borderLeftWidth: sheet.borderLeftWidth,
    borderRightWidth: sheet.borderRightWidth,
    get paddingLeft() { return el.style.paddingLeft || sheet.padding; },
    get paddingRight() { return el.style.paddingRight || sheet.padding; },
  });
}

const inline = (el) => ({
  width: el.style.width, minWidth: el.style.minWidth,
  paddingLeft: el.style.paddingLeft, paddingRight: el.style.paddingRight,
  whiteSpace: el.style.whiteSpace,
});
const NO_INLINE = { width: '', minWidth: '', paddingLeft: '', paddingRight: '', whiteSpace: '' };
const px = (value) => parseFloat(value);

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
  it('still shows Stop, but says Stopping to assistive tech and in the tooltip, routes to code.stop, and is marked disabled', () => {
    const { view, editor, output, tip } = page();
    view.set('running');
    view.set('stopping');
    expect(text(editor, 'label')).toBe('Stop');
    expect(text(output, 'label')).toBe('Stop');
    expect(iconClass(editor)).toBe('fa fa-stop');
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

// The control never changes size: it keeps the outer width it measured as Run, and
// Stop, a few pixels wider than Run, takes the difference from its side padding.
describe('width', () => {
  it('keeps the width each control has as Run through Stop and Stopping, and hands the padding back on Run', () => {
    const p = page();
    layOut(p, { editor: { Run: 76.4, Stop: 80.4 }, output: { Run: 90.2, Stop: 94.2 } });
    const held = [[p.editor, '76.4px'], [p.output, '90.2px']];

    for (const state of ['running', 'stopping']) {
      p.view.set(state);
      for (const [el, width] of held) {
        expect(el.style.width, state).toBe(width);
        // Stop is 4 px wider than Run, so each side gives up 2 of its 16 px, and
        // the content stays centered.
        expect(px(el.style.paddingLeft), state).toBeCloseTo(14, 6);
        expect(px(el.style.paddingRight), state).toBeCloseTo(14, 6);
        expect(el.style.minWidth, state).toBe('');
        // The fit is exact, so a rounding shortfall must not wrap the label under the icon.
        expect(el.style.whiteSpace, state).toBe('nowrap');
      }
    }

    p.view.set('idle');
    for (const [el] of held) { expect(inline(el)).toEqual(NO_INLINE); }
  });

  it('keeps sub-pixel widths instead of rounding them to whole pixels', () => {
    // With the label hidden, below the large breakpoint, only the icons differ, by about 1 px.
    const p = page();
    layOut(p, { editor: { Run: 45.578125, Stop: 46.71875 } });
    p.view.set('running');
    expect(p.editor.style.width).toBe('45.578125px');
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(16 - 0.5703125, 6);
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(16 - 0.5703125, 6);
  });

  it.each([['narrower than', 74.0], ['exactly as wide as', 76.4]])(
    'leaves the padding alone when Stop is %s Run',
    (_, stop) => {
      const p = page();
      layOut(p, { editor: { Run: 76.4, Stop: stop } });
      p.view.set('running');
      expect(p.editor.style.width).toBe('76.4px');
      expect(p.editor.style.paddingLeft).toBe('');
      expect(p.editor.style.paddingRight).toBe('');
    },
  );

  it('never takes more padding than a control has', () => {
    const p = page({ editorStyle: 'padding-left: 1px; padding-right: 3px' });
    layOut(p);   // 2 px to give from each side
    p.view.set('running');
    expect(p.editor.style.paddingLeft).toBe('0px');
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(1, 6);
    expect(p.editor.style.width).toBe('76.4px');
  });

  it('leaves a control that is not rendered alone', () => {
    // A hidden toolbar measures 0 wide.
    const hidden = page();
    layOut(hidden, { editor: { Run: 0, Stop: 0 } });
    hidden.view.set('running');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);
    expect(text(hidden.editor, 'label')).toBe('Stop');
    hidden.view.set('stopping');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);
    hidden.view.set('idle');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);

    // So does jsdom with no layout at all: not even a style attribute appears.
    const bare = page();
    bare.view.set('running');
    expect(bare.editor.hasAttribute('style')).toBe(false);
    expect(bare.output.hasAttribute('style')).toBe(false);
    expect(text(bare.editor, 'label')).toBe('Stop');
  });

  it('squeezes from, and restores, the inline padding, min-width and white-space the markup had', () => {
    const p = page({ editorStyle: 'padding-left: 10px; padding-right: 14px; min-width: 50px; white-space: pre' });
    layOut(p);
    p.view.set('running');
    // From the padding it had, not the stylesheet's.
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(8, 6);
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(12, 6);
    expect(p.editor.style.minWidth).toBe('50px');
    expect(p.editor.style.whiteSpace).toBe('nowrap');
    p.view.set('stopping');
    p.view.set('idle');
    expect(inline(p.editor)).toEqual({
      width: '', minWidth: '50px', paddingLeft: '10px', paddingRight: '14px', whiteSpace: 'pre',
    });
  });

  it('keeps an inline width the markup had, and restores it', () => {
    const p = page({ editorStyle: 'width: 90px' });
    layOut(p);   // the inline width is what the control measures, as Run and as Stop
    p.view.set('running');
    expect(p.editor.style.width).toBe('90px');
    expect(p.editor.style.paddingLeft).toBe('');
    p.view.set('stopping');
    p.view.set('idle');
    expect(inline(p.editor)).toEqual({ ...NO_INLINE, width: '90px' });
  });

  it('does not measure again for a run that starts while stopping', () => {
    const p = page();
    layOut(p);
    p.view.set('running');
    p.view.set('stopping');
    const reads = p.editor.getBoundingClientRect.mock.calls.length;
    expect(reads).toBeGreaterThan(0);   // it did measure, on leaving idle
    p.view.set('running');
    p.view.set('stopping');
    p.view.set('running');
    expect(p.editor.getBoundingClientRect.mock.calls.length).toBe(reads);
    expect(p.editor.style.width).toBe('76.4px');
    expect(text(p.editor, 'label')).toBe('Stop');
  });

  it('measures again at the next run, so a resize between runs is followed', () => {
    const p = page();
    const natural = { editor: { Run: 76.4, Stop: 80.4 } };
    layOut(p, natural);
    p.view.set('running');
    p.view.set('idle');
    // The viewport crossed the large breakpoint, and the label with it, while idle.
    natural.editor.Run = 45.6;
    natural.editor.Stop = 46.8;
    p.view.set('running');
    expect(p.editor.style.width).toBe('45.6px');
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(15.4, 6);
  });

  it.each([['wider than', 80.4, 14], ['narrower than', 74.0, 16]])(
    'sizes a content-box control by its content width when Stop is %s Run, so its outer width is still the one it had',
    (_, stop, padding) => {
      const p = page();
      layOut(p, { editor: { Run: 76.4, Stop: stop } },
        { ...SHEET, boxSizing: 'content-box', borderLeftWidth: '1px', borderRightWidth: '1px' });
      p.view.set('running');
      // A Stop 4 px wider takes 2 px from each side's 16 px; a Stop that fits takes none.
      const side = (name) => px(p.editor.style[name] || SHEET.padding);
      expect(side('paddingLeft')).toBeCloseTo(padding, 6);
      expect(side('paddingRight')).toBeCloseTo(padding, 6);
      const outer = px(p.editor.style.width) + side('paddingLeft') + side('paddingRight') + 2;   // 2: the 1 px borders
      expect(outer).toBeCloseTo(76.4, 6);
    },
  );
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
