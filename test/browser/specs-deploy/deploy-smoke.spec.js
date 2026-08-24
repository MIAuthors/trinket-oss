const { test, expect } = require('@playwright/test');

// Deploy smoke: does this SERVER, with its own overlay and config, actually work?
//
// Everything here is anonymous and read-only, so it is safe to run against a
// live deployment. It covers the things a local stack cannot prove — which
// build is live, what headers this server sends, whether the deploy's overlay
// pages render — plus one end-to-end run of each production trinket type.

test.describe('the server is alive and is the build we think', () => {
  test('home page renders', async ({ page }) => {
    const res = await page.goto('/');
    expect(res.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/trinket/i);
  });

  test('/version reports a real build, not a placeholder', async ({ request }) => {
    const info = await (await request.get('/version')).json();
    expect(info.commit, 'commit should be a short sha').toMatch(/^[0-9a-f]{7,}$/);
    expect(info.commit).not.toBe('unknown');

    // Image-only deploys have no .git, so an unstamped build silently reports
    // whatever build-info.json was committed. 'env' or 'checkout' means the
    // reading is real; 'build' means it may be stale.
    expect(['env', 'checkout', 'build']).toContain(info.commitSource);

    if (process.env.EXPECT_COMMIT) {
      // When asserting WHICH build is live, a 'build' source is not evidence —
      // it is the one source that can report a commit the server is not
      // running (a committed build-info.json). Accepting it here would let
      // the exact failure this test exists for pass.
      expect(['env', 'checkout'],
        'EXPECT_COMMIT needs a stamped image or a checkout — commitSource "build" cannot prove the running commit'
      ).toContain(info.commitSource);
      expect(info.commit).toBe(process.env.EXPECT_COMMIT.substring(0, info.commit.length));
    }
  });

  test('a deployed server runs in production mode', async ({ request }) => {
    const info = await (await request.get('/version')).json();
    // NODE_ENV unset means no view caching, no local-production.yaml, and
    // `enable: false` route gating inert (issue #111).
    expect(info.nodeEnv, 'deployed servers should set NODE_ENV=production').toBe('production');
  });
});

test.describe('embeds carry the right content policy', () => {
  test('a normal embed allows remote images but never frames', async ({ request }) => {
    const res = await request.get('/embed/glowscript');
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'embeds should carry a policy').toBeTruthy();
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toMatch(/img-src[^;]*\*/);          // course material uses remote textures
    expect(csp).toMatch(/worker-src[^;]*blob:/);    // the worker runtimes must start
  });

  test('calculatorMode is self-contained', async ({ request }) => {
    const res = await request.get('/embed/glowscript?runMode=calculator');
    const csp = res.headers()['content-security-policy'];
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toMatch(/img-src[^;]*\*/);      // no third-party images in a test
    expect(csp).not.toMatch(/connect-src[^;]*\*/);  // and no general network egress
  });
});

// Same helpers the local suite uses: `.run-it` is the Run control, and console
// output lands in #console-output.
async function editorRun(page, path, code) {
  await page.goto(path);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}

async function consoleText(page) {
  return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
}

test.describe('the trinket types this deployment actually serves', () => {
  // WebVPython: compiled client-side and rendered with WebGL. If the components
  // bundle or the CDN allowance is wrong on this deploy, this is where it shows.
  test('a WebVPython program renders a canvas', async ({ page }) => {
    await editorRun(page, '/embed/glowscript', 'Web VPython 3.2\nsphere(color=color.red)\n');

    // The scene renders inside a sandboxed, opaque-origin iframe, so its
    // document is unreachable from the page — walk the frames instead and
    // require a canvas with real dimensions.
    await expect(async () => {
      let rendered = false;
      for (const frame of page.frames()) {
        if (await frame.locator('canvas').count().catch(() => 0) === 0) continue;
        const sized = await frame.locator('canvas').first()
          .evaluate((c) => c.width > 1 && c.height > 1).catch(() => false);
        if (sized) { rendered = true; break; }
      }
      expect(rendered).toBe(true);
    }).toPass({ timeout: 90_000 });
  });

  // Pyodide fetches its runtime and wheels from a CDN at run time, so this
  // proves the deploy's policy actually permits that.
  test('a python3 program runs and prints', async ({ page }) => {
    await editorRun(page, '/embed/python3', 'print("deploy smoke", 6 * 7)\n');
    await expect(async () => {
      expect(await consoleText(page)).toContain('42');
    }).toPass({ timeout: 120_000 });   // pyodide fetches its runtime on first run
  });
});

test.describe('a program cannot pull in third-party content', () => {
  // The exam-integrity property: a program may inject markup, but the policy
  // refuses the load. Checked here because it depends on the deployed headers,
  // not just the code.
  test('an injected iframe is refused', async ({ page }) => {
    const violations = [];
    page.on('console', m => {
      const t = m.text();
      if (/Content Security Policy|frame-src/i.test(t)) violations.push(t);
    });

    await editorRun(page, '/embed/glowscript?runMode=calculator',
      'Web VPython 3.2\npoints()\n' +
      'scene.__canvas_element.parentElement.innerHTML = ' +
      '\'<iframe src="https://example.com" width=300 height=200></iframe>\'\n');

    await expect.poll(() => violations.length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(violations.join(' ')).toMatch(/frame-src/);
  });
});
