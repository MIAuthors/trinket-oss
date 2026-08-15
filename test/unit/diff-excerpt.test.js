import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { firstDivergenceIndex, excerptAround } =
  require(path.resolve(__dirname, '../../lib/shared/diff-excerpt.js'));

describe('firstDivergenceIndex', () => {
  it('returns -1 for identical strings', () => {
    expect(firstDivergenceIndex('<p>a</p>', '<p>a</p>')).toBe(-1);
  });

  it('finds the first differing character', () => {
    expect(firstDivergenceIndex('<h1>hi</h1>', '<h1 id="hi">hi</h1>')).toBe(3);
  });

  it('treats a pure prefix as diverging at the end of the shorter string', () => {
    expect(firstDivergenceIndex('abc', 'abcdef')).toBe(3);
    expect(firstDivergenceIndex('abcdef', 'abc')).toBe(3);
  });

  it('handles null/undefined as empty strings', () => {
    expect(firstDivergenceIndex(null, undefined)).toBe(-1);
    expect(firstDivergenceIndex(null, 'x')).toBe(0);
  });
});

describe('excerptAround', () => {
  it('reports the divergence index alongside the excerpts', () => {
    const ex = excerptAround('<h1>hi</h1>', '<h1 id="hi">hi</h1>');
    expect(ex.index).toBe(3);
    expect(ex.legacy).toBe('<h1>hi</h1>');
    expect(ex.modern).toBe('<h1 id="hi">hi</h1>');
  });

  it('truncates to the requested width and marks the elision', () => {
    const ex = excerptAround('a'.repeat(500) + 'L' + 'a'.repeat(500),
                             'a'.repeat(500) + 'M' + 'a'.repeat(500), 20);
    expect(ex.index).toBe(500);
    // window starts 40 chars before the divergence, so both sides are elided
    // at BOTH ends
    expect(ex.legacy.startsWith('…')).toBe(true);
    expect(ex.legacy.endsWith('…')).toBe(true);
    expect(ex.legacy.replace(/…/g, '').length).toBe(20);
  });

  it('cuts the SAME window from both sides so the excerpts line up', () => {
    const legacy = 'x'.repeat(100) + 'LEGACY' + 'y'.repeat(100);
    const modern = 'x'.repeat(100) + 'MODERN' + 'y'.repeat(100);
    const ex = excerptAround(legacy, modern, 30);
    expect(ex.index).toBe(100);
    expect(ex.legacy).toContain('LEGACY');
    expect(ex.modern).toContain('MODERN');
    // identical leading context on both sides (ellipsis + width/4 chars)
    expect(ex.legacy.slice(0, 8)).toBe(ex.modern.slice(0, 8));
  });

  it('does not mark an elision when the whole string fits', () => {
    const ex = excerptAround('short a', 'short b', 200);
    expect(ex.legacy).toBe('short a');
    expect(ex.modern).toBe('short b');
  });

  it('falls back to the default width for a bad width argument', () => {
    const ex = excerptAround('a'.repeat(500) + 'X' + 'a'.repeat(500),
                             'a'.repeat(500) + 'Y' + 'a'.repeat(500), 0);
    expect(ex.legacy.replace(/…/g, '').length).toBe(200);
  });
});
