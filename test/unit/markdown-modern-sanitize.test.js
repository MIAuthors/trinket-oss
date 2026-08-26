import { describe, it, expect } from 'vitest';
import { buildParser } from './markdown-modern-core.test.js';

describe('DOMPurify profile', () => {
  const parse = buildParser();

  it('strips script tags and event handlers', () => {
    expect(parse('<script>alert(1)</script>hello')).not.toContain('<script');
    expect(parse('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });

  it('strips javascript: hrefs', () => {
    expect(parse('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('strips data: and vbscript: hrefs', () => {
    expect(parse('<a href="data:text/html,x">x</a>')).not.toContain('data:text/html');
    expect(parse('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript:');
  });

  it('strips non-whitelisted attributes from tags that have no per-tag rules of their own', () => {
    // em/br used to be in ALLOWED_TAGS without an ATTR_RULES entry, and the
    // attribute hook returned early for rule-less tags — so ANY name in the
    // global ALLOWED_ATTR set (built from every other tag's rules) survived.
    const html = parse('<em style="position:fixed">x</em>');
    expect(html).toContain('<em');
    expect(html).toContain('x');
    expect(html).not.toContain('position:fixed');
    expect(html).not.toContain('style=');
  });

  it('keeps whitelisted inline HTML', () => {
    const html = parse('a <b class="note">bold</b> and <sup>sup</sup>');
    expect(html).toContain('<b class="note">bold</b>');
    expect(html).toContain('<sup>sup</sup>');
  });

  it('drops non-whitelisted attributes but keeps the tag', () => {
    const html = parse('<span class="ok" data-evil="x">t</span>');
    expect(html).toContain('<span class="ok">');
    expect(html).not.toContain('data-evil');
  });

  it('removes iframes whose src is not on the whitelist', () => {
    expect(parse('<iframe src="https://evil.example.com/x"></iframe>')).not.toContain('<iframe');
  });

  it('keeps whitelisted iframes (raw YouTube embed pasted as HTML)', () => {
    const html = parse('<iframe src="https://www.youtube.com/embed/abc" width="420" height="315"></iframe>');
    expect(html).toContain('<iframe');
    expect(html).toContain('youtube.com/embed/abc');
  });

  it('keeps our own generated trinket-fence iframes end to end', () => {
    const html = parse('```python3.trinket\nx=1\n```');
    expect(html).toContain('embedded-trinket');
  });

  it('GFM task-list checkboxes still survive the strict profile', () => {
    expect(parse('- [x] done')).toContain('type="checkbox"');
  });
});
