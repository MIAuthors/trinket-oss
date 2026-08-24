import { describe, it, expect } from 'vitest';
import { buildParser } from './markdown-modern-core.test.js';

describe('math pass-through', () => {
  const parse = buildParser();

  it('inline $..$ survives untouched — underscores must not become <em>', () => {
    const html = parse('the value $x_i + y_j$ matters');
    expect(html).toContain('$x_i + y_j$');
    expect(html).not.toContain('<em>');
  });

  it('display $$..$$ survives with backslashes intact', () => {
    const html = parse('$$\\frac{a}{b}$$');
    expect(html).toContain('$$\\frac{a}{b}$$');
  });

  it('\\(..\\) and \\[..\\] delimiters survive', () => {
    expect(parse('inline \\(a_1\\) math')).toContain('\\(a_1\\)');
    expect(parse('\\[E = mc^2\\]')).toContain('\\[E = mc^2\\]');
  });

  it('TeX containing < is HTML-escaped but textually intact', () => {
    const html = parse('$a < b$');
    expect(html).toContain('$a &lt; b$');
  });

  it('a trailing space just inside the closing $ does not tokenize as math', () => {
    // The closing-delimiter constraint used to be a lookbehind — `(?<!\s)\$`
    // — which Safari < 16.4 cannot even PARSE, so the whole module file failed
    // to load on older iPads and every course silently fell back to legacy.
    // Expressed as a post-match check on the captured content instead; this
    // pins the behavior that check enforces.
    const html = parse('a $x $ b');
    expect(html).toContain('$x $'); // literal text, not a math token
    expect(html).not.toContain('<em>');
  });

  it('a lone $ price does not open a math span', () => {
    const html = parse('costs $5 and _emphasis_ still works');
    expect(html).toContain('<em>emphasis</em>');
  });

  it('stray $$ in prose does not swallow paragraphs across blank lines', () => {
    const html = parse('para one\n\nso much $$ this quarter\n\npara two\n\nalso $$ appears here');
    // para two should be in its own <p>, NOT swallowed into a math block
    expect(html).toContain('<p>para two</p>');
    // both literal $$ should appear as literal text in output
    expect(html).toContain('$$');
    expect((html.match(/\$\$/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('legitimate multi-line $$ block without blank lines survives intact', () => {
    const html = parse('$$\na = 1\nb = 2\n$$');
    expect(html).toContain('$$\na = 1\nb = 2\n$$');
  });

  it('unclosed $$ at end of document renders as prose', () => {
    const html = parse('$$x = 1');
    // Should not be trapped in a math span; should appear as literal text
    expect(html).toContain('x = 1');
    expect(html).not.toContain('$$\n');
  });
});
