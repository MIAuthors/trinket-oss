'use strict';

// A branded deploy's assets must reach the CDN too.
//
// deploys/<name>/public/ shadows public/ at runtime — config/deploy-dir.js says
// so outright ("static assets ahead of public/ — same-name shadowing"). The
// hosting publish did not mirror that: it stages public/ out of the BUILT IMAGE,
// and an overlay lives in the deploy folder, never in the image. So every
// overlay-only asset was absent from Hosting and rode the rewrite to Cloud Run
// on every single view.
//
// Measured on mandi 2026-09-02, right after a healthy deploy:
//   cache-prefix-104497d/css/brand-overrides.css -> x-cache: MISS, 14,563 bytes
// permanently, for every new visitor. uindy scored 25/25 on the same check only
// because its pages reference no overlay asset at all.
const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT   = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-hosting.sh');
const COMMIT = 'abc1234';

// Stage a publish the way a branded deploy does: stock assets from the image
// (ASSET_SRC stands in for the extraction) plus an overlay that adds one file
// and shadows another.
function stage({ withOverlay }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-pub-'));
  const src = path.join(dir, 'image-public');
  fs.mkdirSync(path.join(src, 'css'), { recursive: true });
  fs.writeFileSync(path.join(src, 'css', 'base.css'), 'body{color:stock}');

  const deployName = 'brandtest';
  const overlay = path.join(dir, 'deploys', deployName, 'public');
  if (withOverlay) {
    fs.mkdirSync(path.join(overlay, 'css'), { recursive: true });
    // Overlay-only file — the mandi case.
    fs.writeFileSync(path.join(overlay, 'css', 'brand-overrides.css'), '.brand{}');
    // Same-name file — must SHADOW the stock one, as it does at runtime.
    fs.writeFileSync(path.join(overlay, 'css', 'base.css'), 'body{color:branded}');
  }

  const out = path.join(dir, 'staged');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FIREBASE_PROJECT: 'p', HOSTING_SITE: 's', HOSTING_REWRITES: '[]',
      COMMIT, ASSET_SRC: src,
      TRINKET_DEPLOY: deployName,
      OVERLAY_ROOT: dir,          // where deploys/<name>/public lives for this test
      STAGE_ONLY: '1', STAGE_OUT: out,
      SERVICE_URL: '', IMAGE: '',
    },
  });
  return { r, out };
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

describe('the hosting publish includes the active overlay', () => {
  it('publishes an overlay-only asset at both the stamped and bare paths', () => {
    const { r, out } = stage({ withOverlay: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    expect(read(path.join(out, 'site', `cache-prefix-${COMMIT}`, 'css', 'brand-overrides.css')),
      'the branded CSS must be uploaded under the versioned prefix the app emits')
      .toBe('.brand{}');
    expect(read(path.join(out, 'site', 'css', 'brand-overrides.css')),
      'and at the bare path, like every other published asset')
      .toBe('.brand{}');
  });

  it('lets the overlay shadow a stock asset, exactly as it does at runtime', () => {
    const { out } = stage({ withOverlay: true });
    expect(read(path.join(out, 'site', `cache-prefix-${COMMIT}`, 'css', 'base.css')),
      'publishing the stock file over the branded one would serve the wrong brand from the edge')
      .toBe('body{color:branded}');
  });

  it('still publishes stock assets when there is no overlay', () => {
    const { r, out } = stage({ withOverlay: false });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(path.join(out, 'site', `cache-prefix-${COMMIT}`, 'css', 'base.css')))
      .toBe('body{color:stock}');
  });

  // The staging above is only reachable if the caller actually passes the
  // deploy name through. It arrives by sourcing .env, which does not export it,
  // so an unpassed TRINKET_DEPLOY makes the whole feature a no-op on real
  // deploys while every test here still passes.
  it('deploy-cloudrun.sh passes TRINKET_DEPLOY to the publish', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'deploy-cloudrun.sh'), 'utf8');
    // The REAL invocation — not the earlier mention inside the docker-missing
    // error message, which is why this looks for the `bash ...` execution.
    const at = sh.indexOf('bash "${SCRIPT_DIR}/scripts/deploy-hosting.sh"');
    expect(at, 'could not find the deploy-hosting.sh invocation').toBeGreaterThan(-1);
    const invocation = sh.slice(sh.lastIndexOf('if ! ', at), at);
    expect(invocation, 'the overlay publish is dead code unless the deploy name is passed')
      .toMatch(/TRINKET_DEPLOY=/);
  });
});
