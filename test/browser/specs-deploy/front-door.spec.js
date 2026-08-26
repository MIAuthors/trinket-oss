const { test, expect } = require('@playwright/test');

// A deployment can sit behind a CDN or proxy (Firebase Hosting, Cloudflare).
// When it does, the app receives the BACKEND's host, not the browser's, and any
// template rendering an absolute URL from it advertises a foreign origin.
// Angular then refuses the embed iframe as [$sce:insecurl] and the trinket
// never renders.
//
// This class of failure is invisible to the rest of the deploy smoke: those
// tests navigate to /embed/... URLs they construct themselves, so nothing
// exercises a page where the CLIENT builds the URL. Behind a broken CDN front
// door the whole suite passed 8/8 while the library page was dead.

const URL_TRUST_ERROR = /insecurl|\$interpolate:interr/;

function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.describe('the deployment advertises the origin the browser is using', () => {
  test('apphostname matches the host being browsed', async ({ page, baseURL }) => {
    // The single invariant behind the whole failure, and it needs no fixture:
    // whatever front door served this page must be the one the client builds
    // URLs against.
    await page.goto('/');
    const advertised = await page.evaluate(
      () => window.trinket && window.trinket.config && window.trinket.config.apphostname
    );
    expect(advertised, 'page should expose trinket.config.apphostname').toBeTruthy();
    expect(advertised).toBe(new URL(baseURL).host);
  });

  test('the home page raises no URL-trust errors', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/', { waitUntil: 'networkidle' });
    const refused = errors.filter((e) => URL_TRUST_ERROR.test(e));
    expect(refused, `Angular refused a URL: ${refused[0] || ''}`).toHaveLength(0);
  });
});

test.describe('an embedded trinket loads from the same origin as its page', () => {
  test('the page never names the backend origin anywhere', async ({ page, baseURL }) => {
    // Needs no fixture. Deliberately matches a BARE host too, not just an
    // https:// URL: the misconfiguration first surfaces as a hostname inside
    // the client config block (apphostname: 'x.run.app'), with no scheme — an
    // earlier version of this test looked for https:// only and passed against
    // a build that was genuinely broken.
    const browsing = new URL(baseURL).host;
    test.skip(/\.run\.app$/.test(browsing), 'browsing the backend directly');

    await page.goto('/');
    const leaked = await page.evaluate(() =>
      (document.documentElement.innerHTML.match(/[a-z0-9-]+\.[a-z0-9-]+\.run\.app/g) || [])
        .filter((v, i, a) => a.indexOf(v) === i)
    );
    expect(leaked, 'page should never name the Cloud Run backend origin').toEqual([]);
  });

  test('a trinket page renders a same-origin embed', async ({ page, baseURL }) => {
    // End-to-end version of the same invariant. There is no anonymous trinket
    // listing to crawl, so the path is supplied per deployment:
    //   SMOKE_TRINKET_PATH=/library/trinkets/<id>
    const href = process.env.SMOKE_TRINKET_PATH;
    test.skip(!href, 'set SMOKE_TRINKET_PATH=/library/trinkets/<id> to run this');

    const errors = collectErrors(page);
    await page.goto(href, { waitUntil: 'networkidle' });

    const refused = errors.filter((e) => URL_TRUST_ERROR.test(e));
    expect(refused, `Angular refused the embed URL: ${refused[0] || ''}`).toHaveLength(0);

    const src = await page.locator('iframe').first().getAttribute('src');
    expect(src, 'the trinket page should embed an iframe').toBeTruthy();
    expect(
      new URL(src, baseURL).host,
      'the embed must be same-origin with the page that hosts it'
    ).toBe(new URL(baseURL).host);
  });
});
