'use strict';

// The runner page glowscript.js builds for every Run, executed against a fake
// GlowScript runtime: the stop shim must be installed before the program runs,
// and the runner must report ready, then done -- or stopped -- on both of
// GlowScript's calling styles.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const shim = require('../../public/js/embed/glowscript-stop-shim');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'lib/views/embed/glowscript.html'), 'utf8');
const TEMPLATE = PAGE.split('<textarea id="glowscriptTemplate" class="hide">')[1].split('</textarea>')[0];

function compileTemplate() {
  let exported;
  const src = fs.readFileSync(path.join(ROOT, 'public/js/util/template.js'), 'utf8');
  vm.runInNewContext(src, { window: { TrinketIO: { export: (name, fn) => { exported = fn; } } } });
  return exported.compile(TEMPLATE);
}

// Fill the template the way runCode() in glowscript.js does.
function runnerHtml(version, stopShim) {
  return compileTemplate()({
    prog: 'Web VPython 3.2\nbox()\n',
    url: 'https://trinket.test',
    domain: 'trinket.test',
    path: 'vpython-glowscript',
    prefix: 'cache-prefix-t/',
    lang: 'vpython',
    runMode: '',
    version: version,
    versionStringAdded: false,
    jqueryList: '',
    glowscriptTextarea: 'block',
    stopShim: stopShim === undefined ? shim.source() : stopShim,
  });
}

// A minimal stand-in for the jQuery calls the runner script makes.
function fakeJQuery(window) {
  const $ = (sel) => {
    const el = typeof sel === 'string' ? window.document.querySelector(sel) : sel;
    return {
      0: el,
      text: () => (el ? el.textContent : ''),
      remove: () => { if (el) { el.remove(); } },
      css: () => {},
      append: () => {},
    };
  };
  $.find = () => [];
  return $;
}

// Load the runner page with a fake runtime whose compiler returns `compiled`.
function loadRunner(version, compiled, waits, stopShim) {
  const messages = [];
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('warn', (...args) => warnings.push(args.join(' ')));
  // Forward the runner page's own errors (an uncaught exception, a missing
  // browser API): otherwise they vanish, and the test only reports 'timed out'.
  virtualConsole.on('jsdomError', (error) => {
    console.error('runner page:', error.message);
    if (error.detail) { console.error(error.detail); }
  });
  const dom = new JSDOM(runnerHtml(version, stopShim), {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.$ = fakeJQuery(window);
      window.reportScriptError = () => '';
      window.glowscript_compile = () => compiled;
      window.ticks = 0;
      Object.assign(window, waits);
      window.addEventListener('message', (e) => {
        try { messages.push(JSON.parse(e.data)); } catch (err) { /* plain-string messages */ }
      });
    },
  });
  return { window: dom.window, messages, warnings };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) { throw new Error('timed out'); }
    await sleep(5);
  }
}
const kinds = (messages) => messages.map((m) => Object.keys(m)[0]);

// GlowScript 2.9+: rate() returns a promise the program awaits.
const promiseRate = { rate: () => new Promise((resolve) => setTimeout(resolve, 1)) };
// GlowScript 1.1 to 2.7: rate(n, continuation).
const callbackRate = { rate: (n, next) => { setTimeout(next, 1); } };

describe('the runner template', () => {
  it('installs the stop shim before compiling or running the program', () => {
    const at = (s) => TEMPLATE.indexOf(s);
    expect(at('{{stopShim}}')).toBeGreaterThan(-1);
    expect(at('{{stopShim}}')).toBeLessThan(at('glowscript_compile('));
    expect(at('{{stopShim}}')).toBeLessThan(at('runProgram(compiled)'));
  });
});

describe('GlowScript 2.9 and later (promise style)', () => {
  it('reports ready, then done, when the program finishes', async () => {
    const { messages } = loadRunner('3.2.3',
      'async function __main__() { await rate(30); await rate(30); }', promiseRate);
    await until(() => kinds(messages).includes('glowscript.done'));
    expect(kinds(messages)).toEqual(['glowscript.ready', 'glowscript.done']);
  });

  it('parks a never-ending program on Stop and reports stopped, not done', async () => {
    const { window, messages } = loadRunner('3.2.3',
      'async function __main__() { while (true) { await rate(30); window.ticks += 1; } }', promiseRate);
    await until(() => window.ticks > 3);
    window.postMessage('glowscript.stop', '*');
    await until(() => kinds(messages).includes('glowscript.stopped'));
    const parkedAt = window.ticks;
    await sleep(30);
    expect(window.ticks).toBe(parkedAt);
    expect(kinds(messages)).not.toContain('glowscript.done');
  });

  it('reports an error, and no done, when the program fails', async () => {
    const { messages } = loadRunner('3.2.3',
      'async function __main__() { throw new Error("boom"); }', promiseRate);
    await until(() => kinds(messages).includes('glowscript.error'));
    expect(kinds(messages)).not.toContain('glowscript.done');
  });
});

describe('GlowScript 1.1 to 2.7 (callback style)', () => {
  it('reports ready, then done, when the program finishes', async () => {
    const { messages } = loadRunner('2.7.5',
      '(function (done) { rate(30, function () { done(); }); })', callbackRate);
    await until(() => kinds(messages).includes('glowscript.done'));
    expect(kinds(messages)).toEqual(['glowscript.ready', 'glowscript.done']);
  });

  it('parks a never-ending program on Stop and reports stopped, not done', async () => {
    const { window, messages } = loadRunner('2.7.5',
      '(function (done) { function loop() { window.ticks += 1; rate(30, loop); } loop(); })', callbackRate);
    await until(() => window.ticks > 3);
    window.postMessage('glowscript.stop', '*');
    await until(() => kinds(messages).includes('glowscript.stopped'));
    const parkedAt = window.ticks;
    await sleep(30);
    expect(window.ticks).toBe(parkedAt);
    expect(kinds(messages)).not.toContain('glowscript.done');
  });
});

describe('a failing stop shim', () => {
  const cases = [
    ['3.2.3', 'async function __main__() { await rate(30); }', promiseRate],
    ['2.7.5', '(function (done) { rate(30, function () { done(); }); })', callbackRate],
  ];
  for (const [version, compiled, waits] of cases) {
    it(`never keeps the program from running (GlowScript ${version})`, async () => {
      const { messages, warnings } = loadRunner(version, compiled, waits, 'throw new Error("shim");');
      await until(() => kinds(messages).includes('glowscript.done'));
      expect(kinds(messages)).toEqual(['glowscript.done']);
      expect(warnings.join('\n')).toContain('Stop button unavailable');
    });
  }
});
