import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

// Shared builder — Tasks 3-5 import this from their own test files.
export function buildParser(overrides = {}) {
  const markedModern = require(path.join(ROOT, 'public/js/vendor/marked-modern.js'));
  const createDOMPurify = require(path.join(ROOT, 'public/js/vendor/purify.min.js'));
  const { JSDOM } = require('jsdom');
  const hljs = require('highlight.js');
  const factory = require(path.join(ROOT, 'public/js/trinket-markdown-modern.js'));
  const trinketConfig = Object.assign({
    get: (k) => (k === 'apphostname' ? 'trinket.example.edu' : undefined),
    getUrl: (p) => 'https://trinket.example.edu' + p,
    getKnownHosts: () => ['trinket.example.edu', 'alias.example.edu']
  }, overrides);
  return factory(markedModern, createDOMPurify(new JSDOM('').window), hljs, trinketConfig);
}

describe('trinket-markdown-modern core', () => {
  it('renders GFM tables', () => {
    const html = buildParser()('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders GFM task lists with the checkbox surviving sanitization', () => {
    const html = buildParser()('- [x] done\n- [ ] todo');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
  });

  it('highlights fenced code with a known language via hljs', () => {
    const html = buildParser()('```python\nprint(1)\n```');
    expect(html).toContain('class="hljs"');
    expect(html).toContain('hljs-'); // token spans
  });

  it('renders unknown-language fences as plain code', () => {
    const html = buildParser()('```nosuchlang\nx\n```');
    expect(html).toContain('<code');
    expect(html).not.toContain('hljs-');
  });

  // marked 12 dropped headerIds; legacy (the marked 0.3.2 fork) emits them,
  // and course pages/exports link to those anchors. Ids must match legacy's
  // algorithm exactly (`raw.toLowerCase().replace(/[^\w]+/g, '-')`) or every
  // existing in-page anchor breaks on a course that switches engines.
  describe('heading ids (legacy-compatible)', () => {
    const parse = buildParser();
    const legacy = require(path.join(ROOT, 'lib/shared/trinket-markdown.js'))({});

    it('emits an id on headings', () => {
      expect(parse('# Hello World')).toContain('<h1 id="hello-world">Hello World</h1>');
    });

    it('matches the legacy id for punctuation-heavy and numeric headings', () => {
      ['# Hello World', '## Foo: Bar & Baz -- qux!', '### 1.2 Intro   spaces', '#### under_score']
        .forEach((md) => {
          const want = /id="([^"]*)"/.exec(legacy(md));
          const got = /id="([^"]*)"/.exec(parse(md));
          expect(got, 'modern emitted no id for ' + md).toBeTruthy();
          expect(got[1], 'id mismatch for ' + md).toBe(want[1]);
        });
    });

    it('keeps the id through sanitization at every heading level', () => {
      expect(parse('###### deep heading')).toContain('id="deep-heading"');
    });
  });
});
