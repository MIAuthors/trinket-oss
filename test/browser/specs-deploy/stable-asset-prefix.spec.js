const { test, expect } = require('@playwright/test');

// The components prefix is CONTENT-addressed (#238), and the worker is a MODULE
// worker (#215/#242). Both are deploy facts no unit test can establish.
//
// #238's whole claim is that a component URL survives a deploy while /js/ and
// /css/ roll. A single run cannot prove that — it needs two deploys — so this
// records the current prefixes in a way a second run can compare, and asserts
// the invariant that IS checkable now: components and js must not share a token
// once the hash is in play.

test.describe('asset prefixes', () => {
  test('components use a different token from js/css', async ({ page }) => {
    await page.goto('/embed/glowscript');
    const html = await page.content();

    const comp = /cache-prefix-([a-f0-9]{6,64})\/components\//.exec(html);
    const other = /cache-prefix-([a-f0-9]{6,64})\/(?:js|css)\//.exec(html);
    test.skip(!comp || !other, 'this deploy does not emit both kinds of prefixed URL');

    // Before #238 both were the deploy commit. After it, components carry a
    // content hash — so they diverge, and that divergence is what stops every
    // deploy re-issuing 6.6 MB of unchanged URLs.
    console.log(`  components token: ${comp[1]}   js/css token: ${other[1]}`);
    expect(comp[1], 'components should not be on the deploy token (#238)')
      .not.toBe(other[1]);
  });

  test('the components bundle is served immutable', async ({ page, request }) => {
    await page.goto('/embed/glowscript');
    const html = await page.content();
    const m = /(\/cache-prefix-[a-f0-9]{6,64}\/components\/[^"'\s)]+\.js)/.exec(html);
    test.skip(!m, 'no prefixed component URL on this page');

    const res = await request.get(m[1]);
    expect(res.status()).toBe(200);
    const cc = res.headers()['cache-control'] || '';
    // A deploy without app.cache.enabled serves no-store; that is a real
    // configuration, not a failure, so report rather than fail.
    test.skip(/no-store/.test(cc), 'app.cache.enabled is off on this deploy');
    expect(cc, 'a content-addressed asset should be immutable').toContain('immutable');
  });

  test('the pyodide worker is requested as a module', async ({ page }) => {
    // #242: a classic worker cannot load pyodide 314.x. The page must ask for
    // pyodide.mjs — asking for pyodide.js means the conversion regressed.
    await page.goto('/embed/python3');
    const html = await page.content();
    test.skip(!/workerRuntime["']?\s*:\s*true/.test(html), 'not a worker deploy');
    expect(html, 'the worker must load the module build (#215)').toContain('pyodide.mjs');
  });
});
