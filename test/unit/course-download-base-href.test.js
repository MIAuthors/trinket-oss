'use strict';

// A downloaded course must resolve its own links.
//
// courses.js renders each material into a standalone file on disk (writeTo is
// "NN-lesson/NN-material") and courses/download/view.html emits the material
// body raw — {{ pageContent | safe }} — iframes included. The bundle is opened
// from file:// or served from an arbitrary host, which is why every other
// external reference in the template is deliberately absolute.
//
// That makes the export a SECOND consumer of the stored material bytes, with
// the opposite requirement to the editor: the editor must store host-less URLs
// so a course is not pinned to the deploy that authored it, while the export
// needs those same URLs to resolve outside the app entirely.
//
// A <base href> satisfies both: storage stays host-less, and the downloaded
// copy resolves against the deploy it came from. It also repairs the site logo
// on this template, which is a root-relative path and has therefore been broken
// in exports for as long as they have existed.
//
// This is NOT the serve-time rewrite that caused M&I #7: that regression came
// from rewriting on getMaterial, the path the editor computes its patch base
// against. The download renderer is not that path.
//
// Raised in review of #245 by @drewsday.
const fs   = require('fs');
const path = require('path');

const DL = path.join(__dirname, '..', '..', 'lib', 'views', 'courses', 'download');
const base = fs.readFileSync(path.join(DL, 'base.html'), 'utf8');
const view = fs.readFileSync(path.join(DL, 'view.html'), 'utf8');

describe('downloaded course: standalone link resolution', () => {
  it('declares a <base href> so root-relative URLs resolve outside the app', () => {
    expect(base, 'a downloaded page is opened from file:// or another host, where '
      + '/embed/... and the site logo resolve against the wrong origin')
      .toMatch(/<base\s+href=/i);
  });

  it('points that base at the deploy the export came from', () => {
    const m = /<base\s+href="([^"]+)"/i.exec(base);
    expect(m, 'the base tag should carry an href').toBeTruthy();
    expect(m[1], 'must be templated from config, not hardcoded to one deploy')
      .toMatch(/\{\{\s*config\./);
  });

  // The assertions above pin the TEMPLATE. This one pins the VALUE: config.url
  // is assembled at startup by config/app.config.js (protocol + hostname) and is
  // undefined in the raw config object, so a base href built from the wrong
  // property would render as "/" — present, well-formed, and doing nothing.
  it('resolves a stored host-less embed src to a real absolute URL', () => {
    const config = require('config');
    expect(config.url, 'config.url is set at startup by config/app.config.js')
      .toMatch(/^https?:\/\/[^/]+$/);

    const m = /<base\s+href="([^"]+)"/i.exec(base);
    const href = m[1].replace('{{ config.url }}', config.url);
    expect(href, 'the rendered base must not collapse to "/"').not.toBe('/');

    const stored = '/embed/python3/abc123?start=result';   // what #245 now stores
    const resolved = new URL(stored, href).href;
    expect(resolved).toBe(config.url + stored);
    expect(resolved, 'must not resolve against file:// or a stray host')
      .toMatch(/^https?:\/\//);
  });

  it('still emits the material body raw, iframes included', () => {
    // Guards the assumption the other two rest on: if the body were ever escaped
    // or rewritten here, the base tag would not be what makes embeds work.
    expect(view).toMatch(/\{\{\s*pageContent\s*\|\s*safe\s*\}\}/);
  });
});
