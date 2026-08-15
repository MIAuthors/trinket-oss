import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { engineFor } = require(path.resolve(__dirname, '../../lib/shared/markdown-engine.js'));

describe('engineFor', () => {
  it('absent settings mean legacy', () => {
    expect(engineFor(null)).toBe('legacy');
    expect(engineFor({})).toBe('legacy');
    expect(engineFor({ globalSettings: {} })).toBe('legacy');
  });
  it('only the exact string modern selects modern', () => {
    expect(engineFor({ globalSettings: { markdownEngine: 'modern' } })).toBe('modern');
    expect(engineFor({ globalSettings: { markdownEngine: 'Modern' } })).toBe('legacy');
    expect(engineFor({ globalSettings: { markdownEngine: 'legacy' } })).toBe('legacy');
  });
  it('works on plain objects and toObject-style documents', () => {
    const doc = { toObject: () => ({ globalSettings: { markdownEngine: 'modern' } }) };
    expect(engineFor(doc)).toBe('modern');
  });
});
