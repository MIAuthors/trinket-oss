import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

describe('vendored modern markdown libraries', () => {
  it('marked-modern loads via require and exposes Marked without touching any global', () => {
    const markedModern = require(path.join(ROOT, 'public/js/vendor/marked-modern.js'));
    expect(typeof markedModern.Marked).toBe('function');
    const m = new markedModern.Marked({ gfm: true });
    expect(m.parse('# hi').trim()).toBe('<h1>hi</h1>');
    // the legacy fork owns the `marked` module name; the vendored file must not shadow it
    const legacy = require('marked');
    expect(typeof legacy.Renderer).toBe('function'); // 0.3.2 fork API
  });

  it('DOMPurify loads via require and sanitizes with a jsdom window', () => {
    const createDOMPurify = require(path.join(ROOT, 'public/js/vendor/purify.min.js'));
    const { JSDOM } = require('jsdom');
    const purifier = createDOMPurify(new JSDOM('').window);
    expect(purifier.sanitize('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });
});
