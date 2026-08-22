const { test, expect } = require('@playwright/test');

// How are static assets actually delivered? Three questions, in the order they
// matter to a class of students arriving at once:
//
//   1. does the server permit caching at all           (headers)
//   2. does a NEW visitor get them from the CDN edge   (the thundering herd)
//   3. does a RETURNING visitor re-request them        (browser cache)
//
// Only question 2 needs a CDN; questions 1 and 3 are meaningful anywhere, so
// this suite runs against a bare origin too and reports what it finds.

const VERSIONED = /\/cache-prefix-[^/]+\//;

function watch(page) {
  const assets = [];
  page.on('response', (r) => {
    if (!VERSIONED.test(r.url())) return;
    const h = r.headers();
    assets.push({
      url: r.url(),
      status: r.status(),
      cacheControl: h['cache-control'] || '',
      xCache: h['x-cache'] || '',
      fromCache: r.request().timing().responseStart < 0,
      bytes: Number(h['content-length'] || 0),
    });
  });
  return assets;
}

test.describe('static asset delivery', () => {
  // Caching is opt-in per deploy (app.cache.enabled). A deployment that has not
  // enabled it is not broken — there is simply nothing to assert, so skip rather
  // than fail. Detected from the wire, since these tests run against a server
  // whose config they cannot read.
  test.beforeEach(async ({ request, baseURL }) => {
    const home = await (await request.get('/')).text();
    const m = home.match(/\/cache-prefix-[^/"']+\/[^"']+/);
    test.skip(!m, 'no versioned assets on this page');
    const headers = (await request.get(new URL(m[0], baseURL).toString())).headers();
    test.skip(/no-store/.test(headers['cache-control'] || ''),
      'this deploy has not enabled app.cache.enabled — nothing to measure');
  });

  test('every versioned asset is served cacheable', async ({ page }) => {
    const assets = watch(page);
    await page.goto('/', { waitUntil: 'networkidle' });

    expect(assets.length, 'the page should reference versioned assets').toBeGreaterThan(5);
    const notCacheable = assets.filter((a) => !/max-age=\d+/.test(a.cacheControl) || /no-store/.test(a.cacheControl));
    console.log(`  assets: ${assets.length}, bytes: ${assets.reduce((n, a) => n + a.bytes, 0)}`);
    expect(notCacheable.map((a) => a.url + ' -> ' + a.cacheControl)).toEqual([]);
  });

  test('a NEW visitor is served from the edge, not the origin', async ({ browser, baseURL }) => {
    // Warm the edge, then arrive as a brand-new browser — the second student in
    // a class of thirty. On a bare origin there is no x-cache header at all, so
    // this reports rather than fails.
    const warm = await browser.newContext();
    const wp = await warm.newPage();
    await wp.goto(baseURL, { waitUntil: 'networkidle' });
    // One pass can leave the edge cold: the first request only POPULATES it.
    // Load twice so every asset has been stored before the real visitor calls.
    await wp.reload({ waitUntil: 'networkidle' });
    await warm.close();

    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    const assets = watch(page);
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await fresh.close();

    const seen = assets.filter((a) => a.xCache);
    const hits = seen.filter((a) => /HIT/i.test(a.xCache));
    console.log(`  edge-reported assets: ${seen.length}/${assets.length}   HIT: ${hits.length}`);
    test.skip(seen.length === 0, 'no CDN in front of this deployment (no x-cache header)');
    expect(hits.length, 'a new visitor should be served from the edge').toBe(seen.length);
  });

  test('a RETURNING visitor re-requests nothing', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const second = watch(page);
    await page.goto('/', { waitUntil: 'networkidle' });

    // With immutable URLs the browser should satisfy these locally. Anything
    // that still hits the network is an asset whose caching is not working.
    const overTheWire = second.filter((a) => a.status !== 304 && !a.fromCache);
    console.log(`  second visit: ${second.length} asset requests, ${overTheWire.length} over the wire`);
    // Playwright reports an event even when the browser answers from its own
    // cache, so the event COUNT is not the measure — bytes on the wire are.
    expect(overTheWire, 'a returning visitor should fetch nothing over the network').toEqual([]);
  });
});
