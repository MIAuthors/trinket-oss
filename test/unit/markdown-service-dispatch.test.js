// test/unit/markdown-service-dispatch.test.js
// The service file is a browser IIFE; load it in a vm sandbox with stub
// globals and assert the dispatch logic.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadService(opts) {
  opts = opts || {};
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../public/js/services/markdown.js'), 'utf8');
  let factoryFn;
  const sandbox = {
    window: {},
    trinketMarkdown: (opts) => (md) => 'LEGACY:' + md,
    trinketMarkdownModern: opts.trinketMarkdownModern, // injected per test below
    angular: {
      module: () => ({ factory: (name, arr) => { factoryFn = arr[arr.length - 1]; } }),
      extend: Object.assign
    }
  };
  // Modern-engine tests need markedModern/DOMPurify present so the service's
  // guard (which falls back to legacy when either global is missing) doesn't
  // trip; the fallback test deliberately leaves trinketMarkdownModern
  // undefined regardless of these two.
  if (opts.withModernGlobals) {
    sandbox.markedModern = {};
    // The real browser global is DOMPurify's window-bound SINGLETON, which is
    // also callable as a factory: DOMPurify(window) mints a fresh instance.
    // The stub mirrors both shapes so the service's private-instance
    // construction is exercised.
    sandbox.DOMPurify = function(win) {
      sandbox.purifierCalls.push(win);
      return { __instance: sandbox.purifierCalls.length, addHook: () => {}, sanitize: (h) => h };
    };
  }
  sandbox.purifierCalls = [];
  sandbox.window.angular = sandbox.angular;
  vm.runInNewContext(src, sandbox);
  return { sandbox, makeParser: () => factoryFn({ get: () => 'host' }) };
}

describe('markdownParser engine dispatch', () => {
  it('defaults to legacy when no engine option is given', () => {
    const { makeParser } = loadService();
    expect(makeParser()({})('hi')).toBe('LEGACY:hi');
  });

  it('uses the modern engine when engine resolves to modern', () => {
    const { makeParser } = loadService({
      withModernGlobals: true,
      trinketMarkdownModern: () => (md) => 'MODERN:' + md
    });
    expect(makeParser()({ engine: 'modern' })('hi')).toBe('MODERN:hi');
  });

  it('evaluates a function engine per call (late binding)', () => {
    const { makeParser } = loadService({
      withModernGlobals: true,
      trinketMarkdownModern: () => (md) => 'MODERN:' + md
    });
    let current = 'legacy';
    const parse = makeParser()({ engine: () => current });
    expect(parse('a')).toBe('LEGACY:a');
    current = 'modern';
    expect(parse('a')).toBe('MODERN:a');
  });

  it('builds a PRIVATE DOMPurify instance rather than hooking the global singleton', () => {
    // trinketMarkdownModern addHook()s on whatever purifier it is handed.
    // window.DOMPurify is a singleton, so passing it means every parser built
    // on a page stacks another copy of the same hooks onto the shared object,
    // and they all run, cumulatively, on every sanitize() call.
    let received = [];
    const { sandbox, makeParser } = loadService({
      withModernGlobals: true,
      trinketMarkdownModern: (marked, purifier) => { received.push(purifier); return (md) => 'MODERN:' + md; }
    });
    makeParser()({ engine: 'modern' })('hi');
    makeParser()({ engine: 'modern' })('hi');
    expect(sandbox.purifierCalls.length).toBe(2);            // one instance per parser
    expect(sandbox.purifierCalls[0]).toBe(sandbox.window);   // constructed with the window
    expect(received.length).toBe(2);
    expect(received[0]).not.toBe(sandbox.DOMPurify);         // not the global singleton
    expect(received[0]).not.toBe(received[1]);               // and not shared between parsers
  });

  it('falls back to legacy if the modern global is missing', () => {
    const { makeParser } = loadService();
    expect(makeParser()({ engine: 'modern' })('hi')).toBe('LEGACY:hi');
  });
});
