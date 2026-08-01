const { test, expect } = require('@playwright/test');
const JSZip = require('jszip');

// #81: trinket.io exports its Python type as lang:"python". In trinket-oss
// "python" is the DISABLED Skulpt engine, so an imported trinket 404s on open
// ("This trinket type is not available"). The fix normalizes python->python3
// (Pyodide) at the single readTrinketFromZip seam. This drives the REAL import
// endpoint with a legacy lang:"python" export zip and asserts the result opens
// AND runs as python3 — not a 404. Runs authenticated (global-setup).
test.describe('Legacy trinket.io "python" import (#81)', () => {
  test('a lang:"python" trinket imports and opens/runs as python3 (not 404)', async ({ page, request }) => {
    // Build a minimal trinket.io export zip in the exact shape readTrinketFromZip
    // expects: manifest.json + {lang}/{name}_{shortCode}/{metadata.json,code}.
    // Unique per run: the smoke stack persists between runs (unlike vitest), so a
    // fixed shortCode would be deduped/skipped on re-run. Fresh code = always imports.
    const legacyShortCode = 'legacy81' + Date.now().toString(36);
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ trinkets: [{ shortCode: legacyShortCode, lang: 'python' }] }));
    const dir = `python/LegacyPy_${legacyShortCode}/`;
    zip.file(dir + 'metadata.json', JSON.stringify({
      name: 'Legacy Py 81', description: 'imported from trinket.io', lang: 'python', settings: {},
    }));
    zip.file(dir + 'main.py', 'print("legacy import 8142")');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    // POST to the import endpoint. The `request` fixture inherits the authed
    // storageState + baseURL from the config, so the session cookie rides along.
    const res = await request.post('/api/imports/trinkets', {
      multipart: { file: { name: 'export.zip', mimeType: 'application/zip', buffer } },
    });
    expect(res.ok(), `import POST failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();

    const body = await res.json();
    // importTrinkets replies { data: { imported, skipped, failed, mapping } }.
    expect(body.data.imported).toBe(1);
    const newShortCode = body.data.mapping[legacyShortCode];
    expect(newShortCode, 'import returned a new shortCode for the legacy trinket').toBeTruthy();

    // Proof of the fix: served as python3 (enabled Pyodide), NOT python (disabled
    // Skulpt). The embed URL is /embed/{lang}/{shortCode}.
    const asPython3 = await page.request.get(`/embed/python3/${newShortCode}`);
    expect(asPython3.status(), 'imported trinket serves as python3 (normalized)').toBe(200);
    const asPython = await page.request.get(`/embed/python/${newShortCode}`);
    expect(asPython.status(), 'the disabled "python" type would 404 — proves normalization mattered').toBe(404);

    // Open it and confirm it carries the imported code and RUNS on Pyodide.
    const resp = await page.goto(`/embed/python3/${newShortCode}`);
    expect(resp.status()).toBe(200);
    await expect(page.locator('.ace_editor')).toBeVisible();  // the 404 page has no editor
    await page.locator('.run-it').first().click();
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        if (!out) return '';
        let t = out.innerText || '';
        for (const f of out.querySelectorAll('iframe')) {
          try { t += '\n' + (f.contentDocument?.body?.innerText || ''); } catch (e) {}
        }
        return t;
      });
      expect(text).toContain('legacy import 8142');
      expect(text).not.toContain('not available');
    }).toPass({ timeout: 90_000 });
  });
});
