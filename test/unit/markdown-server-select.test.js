import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parserFor } = require(path.resolve(__dirname, '../../lib/controllers/courses.js'));

describe('server-side parser selection', () => {
  it('legacy course (absent setting) gets the legacy parser', () => {
    const html = parserFor({})('*hi*');
    expect(html).toContain('<em>hi</em>');
  });
  it('modern course gets the modern parser (task list proves GFM)', () => {
    const html = parserFor({ globalSettings: { markdownEngine: 'modern' } })('- [x] d');
    expect(html).toContain('type="checkbox"');
  });
});
