import { describe, it, expect } from 'vitest';
import { buildParser } from './markdown-modern-core.test.js';

describe('embed URL conversion', () => {
  const parse = buildParser();

  it('a YouTube link becomes an embed iframe', () => {
    const html = parse('[demo](https://www.youtube.com/watch?v=abc123)');
    expect(html).toContain('<iframe');
    expect(html).toContain('//www.youtube.com/embed/abc123');
  });

  it('a self-hosted trinket URL (known host) becomes an embedded-trinket iframe', () => {
    const html = parse('[t](https://alias.example.edu/embed/python3/deadbeef00)');
    expect(html).toContain('embedded-trinket');
    expect(html).toContain('/embed/python3/deadbeef00');
  });

  it('an ordinary link stays a link', () => {
    const html = parse('[site](https://example.org/page)');
    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.org/page"');
  });

  it('image sizing =WxH emits width/height', () => {
    const html = parse('![alt](https://example.org/i.png =300x200)');
    expect(html).toContain('width="300"');
    expect(html).toContain('height="200"');
  });

  it('plotly image syntax emits the plotly iframe', () => {
    const html = parse('![plotly](someuser:42)');
    expect(html).toContain('plot.ly/~someuser/42');
  });

  it('a Vimeo image-style embed converts too', () => {
    const html = parse('![v](https://vimeo.com/12345)');
    expect(html).toContain('player.vimeo.com/video/12345');
  });

  it('an unsized root-relative image keeps its src, prefixed with the app URL', () => {
    // Course-material uploads are referenced as /api/files/<id>/<name>; the
    // getUrl() rewrite used to be computed and then thrown away, so the img
    // fell through to marked's default renderer with the RELATIVE href, which
    // the img.src whitelist then stripped — a blank image on every page.
    const html = parse('![pic](/api/files/abc/pic.png)');
    expect(html).toContain('<img');
    expect(html).toContain('src="https://trinket.example.edu/api/files/abc/pic.png"');
    expect(html).toContain('alt="pic"');
  });

  it('an unsized external image keeps its src', () => {
    const html = parse('![x](https://example.org/i.png)');
    expect(html).toContain('src="https://example.org/i.png"');
  });

  it('an unsized image keeps its title', () => {
    const html = parse('![x](https://example.org/i.png "a caption")');
    expect(html).toContain('title="a caption"');
  });

  it('a YouTube embed keeps its iframe title attribute', () => {
    const html = parse('[demo](https://www.youtube.com/watch?v=abc123)');
    expect(html).toContain('title="demo"');
  });

  it('a course-material ViewerJS embed (PDF/ODP/ODT/ODS/FODT upload) becomes an iframe', () => {
    // Exact shape courseEditor/controllers/materialControl.js inserts for
    // these file types (lines 186-198): `!` + link syntax, url prefixed
    // with /components/viewerjs/index.html#, title = file name.
    const html = parse('![syllabus.pdf](/components/viewerjs/index.html#../../syllabus.pdf "syllabus.pdf")');
    expect(html).toContain('<iframe');
    expect(html).toContain('/components/viewerjs/index.html#');
  });
});

describe('link handling (legacy processLink parity)', () => {
  const parse = buildParser();

  it('keeps site-relative, anchor and bare-relative hrefs', () => {
    expect(parse('[a](/u/bob/courses/x)')).toContain('href="/u/bob/courses/x"');
    expect(parse('[b](#section-two)')).toContain('href="#section-two"');
    expect(parse('[c](02-lesson.md)')).toContain('href="02-lesson.md"');
  });

  it('opens non-anchor links in a new window', () => {
    expect(parse('[site](https://example.org/page)')).toContain('target="_blank"');
    expect(parse('[rel](/u/bob/courses/x)')).toContain('target="_blank"');
  });

  it('does NOT add target=_blank to an in-page anchor link', () => {
    expect(parse('[b](#section-two)')).not.toContain('target="_blank"');
  });

  it('routes .ipynb links through nbviewer', () => {
    expect(parse('[nb](https://x.org/f.ipynb)')).toContain('nbviewer.org');
  });

  it('routes root-relative .ipynb links through nbviewer with the app hostname', () => {
    expect(parse('[nb](/api/files/abc/f.ipynb)'))
      .toContain('nbviewer.org/urls/trinket.example.edu/api/files/abc/f.ipynb');
  });
});
