'use strict';

// The embed must project assetToken, or every client-built asset URL busts cache.
//
// public/js/trinket-config.js prefix() ends with:
//
//   : '/' + config.cachePrefix + (config.assetToken || Date.now()) + path;
//
// so without assetToken the client mints a UNIQUE url on every render. That is
// worse than an un-prefixed path: a short TTL still revalidates to a 304, but a
// url nothing has ever seen is always a full 200. Measured on the trial, a
// returning student's open->edit->run cycle spent 27.6 KiB of its 30.9 KiB on
// exactly this, forever (#269).
//
// The app pages have never had the bug: lib/views/base.html includes
// includes/app-config.html, which projects cachePrefix AND assetToken. The embed
// hand-rolls its own config block instead of including that file, and its copy
// carries only cachePrefix. So this is a one-line copy of a known-good pattern,
// not a design question — diagnosis refined by @lengelhardt on #269.
const fs   = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'views', p), 'utf8');

describe('embed projects assetToken to the client', () => {
  it('projects assetToken alongside cachePrefix', () => {
    const embed = read('embed/base.html');
    expect(embed, 'the embed config block should carry cachePrefix').toMatch(/cachePrefix\s*:/);
    expect(embed,
      'without assetToken, trinket-config.js prefix() falls back to Date.now() and '
      + 'every render mints a url no cache can match')
      .toMatch(/assetToken\s*:/);
  });

  it('uses the same source as the app pages, not a second mechanism', () => {
    // app-config.html is the reference. If these ever diverge, the embed is
    // building URLs from something other than the deploy token again.
    const appCfg = read('includes/app-config.html');
    const embed  = read('embed/base.html');
    expect(appCfg).toMatch(/assetToken\s*:\s*'\{\{\s*assetToken\(\)\s*\}\}'/);
    expect(embed,  'copy the app-config.html form verbatim')
      .toMatch(/assetToken\s*:\s*'\{\{\s*assetToken\(\)\s*\}\}'/);
  });

  it('keeps the client fallback, which is the safety net rather than the path', () => {
    const cfg = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', 'js', 'trinket-config.js'), 'utf8');
    expect(cfg, 'Date.now() should remain as a last resort for a page rendered '
      + 'before assetToken existed — it just must not be the only path')
      .toMatch(/config\.assetToken\s*\|\|\s*Date\.now\(\)/);
  });
});
