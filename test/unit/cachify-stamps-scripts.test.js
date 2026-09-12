'use strict';
// Finish #234: the embed's own scripts must be content-addressed too.
//
// Every embed template builds a list of script paths and hands it to
// cachify_js(name, list). lib/util/cachify.js then emitted them BARE:
//
//   <script src="/js/embed/pyodide.js">
//
// so ~21 requests / ~139 KiB per embed view were served max-age=300 and
// re-validated every five minutes of a class session, while the same files
// referenced through the `cachePrefix` filter were immutable for a year.
// Measured on the v3 trial with #270 already applied: python3 embed = 21 bare
// same-origin assets, all of them from this one function.
//
// The fix is where the emission is: cachify takes a stamping function, and
// nunjucks.js hands it the same stamping the `cachePrefix` filter uses (deploy
// token for /js/, components token for /components/). Templates are untouched.
const cachify      = require('../../lib/util/cachify');
const nunjucks     = require('../../lib/util/nunjucks');
const AssetVersion = require('../../lib/util/assetVersion');
const fs   = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('cachify.js stamps every script it emits', () => {
  it('routes each src through the stamp function it is given', () => {
    const stamp = (src) => '/STAMPED' + src;
    const html = cachify.js('k', ['/js/a.js', '/components/x/y.js'], stamp);
    expect(html).toContain('src="/STAMPED/js/a.js"');
    expect(html).toContain('src="/STAMPED/components/x/y.js"');
    expect(html, 'no bare src may survive').not.toMatch(/src="\/(js|components)\//);
  });
  it('still emits bare paths when no stamp is given (callers that predate this)', () => {
    expect(cachify.js('k', ['/js/a.js'])).toContain('src="/js/a.js"');
  });
});

describe('nunjucks wires cachify_js to the same stamping as the cachePrefix filter', () => {
  it('exports the stamper, and it uses the deploy token for /js/ and the components token for /components/', () => {
    expect(typeof nunjucks.stampSrc, 'nunjucks.js must export stampSrc').toBe('function');
    expect(nunjucks.stampSrc('/js/embed/pyodide.js'))
      .toBe('/cache-prefix-' + AssetVersion.token() + '/js/embed/pyodide.js');
    expect(nunjucks.stampSrc('/components/jq-console/jqconsole.min.js'))
      .toBe('/cache-prefix-' + AssetVersion.componentsToken() + '/components/jq-console/jqconsole.min.js');
  });
  it('passes that stamper to cachify in the render context', () => {
    const src = read('lib/util/nunjucks.js');
    expect(src, 'context must not hand templates the unstamped cachify.js directly')
      .not.toMatch(/cachify_js\s*:\s*cachify\.js\b/);
    expect(src).toMatch(/cachify\.js\([^)]*stampSrc\)/);
  });
  it('the embed templates route their script lists through cachify_js (the seam this fix relies on)', () => {
    for (const t of ['pyodide.html', 'glowscript.html', 'python.html']) {
      expect(read('lib/views/embed/' + t), t + ' should use cachify_js').toMatch(/cachify_js\(/);
    }
  });
});

describe('runtime-built asset URLs in pyodide.js carry the deploy token when one exists', () => {
  const src = read('public/js/embed/pyodide.js');
  it('wraps the /js/ literals fetched at runtime (worker, .py helpers, vpython zip)', () => {
    for (const lit of ['/js/embed/pyodide-worker.js', '/js/embed/wvpython/vpython.zip',
                       '/js/embed/wvpython/vpython/_async_transform.py', '/js/embed/_trinket_display.py']) {
      expect(src, lit + ' must go through assetUrl()').toMatch(new RegExp("assetUrl\\('" + lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\)"));
    }
  });
  it('only stamps when assetToken is present — without it prefix() would mint Date.now() urls, worse than bare (#269)', () => {
    expect(src).toMatch(/function assetUrl\(/);
    expect(src).toMatch(/get\('assetToken'\)/);
  });
});
