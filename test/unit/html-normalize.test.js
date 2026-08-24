import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeHtml } = require(path.resolve(__dirname, '../../lib/shared/html-normalize.js'));

describe('normalizeHtml', () => {
  it('ignores attribute order', () => {
    expect(normalizeHtml('<a href="x" title="t">y</a>'))
      .toBe(normalizeHtml('<a title="t" href="x">y</a>'));
  });
  it('ignores whitespace between block tags', () => {
    expect(normalizeHtml('<p>a</p>\n\n  <p>b</p>'))
      .toBe(normalizeHtml('<p>a</p><p>b</p>'));
  });
  it('preserves meaningful text differences', () => {
    expect(normalizeHtml('<p>a b</p>')).not.toBe(normalizeHtml('<p>ab</p>'));
  });
  it('preserves attribute value differences', () => {
    expect(normalizeHtml('<iframe src="a">')).not.toBe(normalizeHtml('<iframe src="b">'));
  });
  it('preserves whitespace inside <pre><code> (rendering-significant)', () => {
    expect(normalizeHtml('<pre><code>a  b</code></pre>'))
      .not.toBe(normalizeHtml('<pre><code>a b</code></pre>'));
  });
  it('preserves exact content and indentation inside <pre><code>', () => {
    expect(normalizeHtml('<pre><code>  line1\n    line2</code></pre>'))
      .toBe(normalizeHtml('<pre><code>  line1\n    line2</code></pre>'));
    expect(normalizeHtml('<pre><code>x\n  y</code></pre>'))
      .not.toBe(normalizeHtml('<pre><code>x\ny</code></pre>'));
  });
});
