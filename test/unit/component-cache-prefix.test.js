'use strict';

// The component() helper serves 209 KiB per embed view on a 5-minute TTL.
//
// Measured on mandi production (2026-09-09), /embed/python3:
//
//   component() helper   13 reqs   209 KiB   public, max-age=300
//   /js/* (client-built) 19 reqs   114 KiB   public, max-age=300
//   stamped/immutable    10 reqs   100 KiB   max-age=31536000, immutable
//
// Unlike a deploy-scoped miss, this one never decays: after five minutes the
// browser asks again, so an hour of classroom use re-fetches it repeatedly.
//
// The cause is the local fallback in lib/util/component.js, which builds a bare
// path while the very same directory is already served content-addressed
// elsewhere — the glowscript runner stamps it with componentsToken() (#238), and
// deploy-hosting.sh publishes components under cache-prefix-<content hash>.
//
// #234 attributes all 33 bare URLs to client-side JavaScript. Two thirds of the
// bytes are this server-side helper instead, which is a much smaller fix; the
// /js/* half is the part that genuinely needs the client work described there.
const component = require('../../lib/util/component');
const AssetVersion = require('../../lib/util/assetVersion');

function srcOf(html) {
  const m = /(?:src|href)='([^']+)'/.exec(html || '');
  return m ? m[1] : null;
}

describe('component() serves content-addressed URLs', () => {
  it('stamps a local component with the COMPONENTS token', () => {
    const src = srcOf(component('ace-builds', 'src-min-noconflict/ace.js'));
    expect(src, 'a bare /components/... path is served max-age=300 and re-fetched '
      + 'every five minutes of use').not.toMatch(/^\/components\//);
    expect(src).toContain('/components/src-min-noconflict/ace.js');
    expect(src).toMatch(/^\/cache-prefix-/);
  });

  it('uses the components CONTENT hash, not the deploy commit', () => {
    // The whole point of #238: components survive a deploy that does not change
    // them. Stamping these with the commit token would re-issue 209 KiB per
    // browser on every deploy instead of once per content change.
    const src = srcOf(component('ace-builds', 'src-min-noconflict/ace.js'));
    expect(src).toContain('/cache-prefix-' + AssetVersion.componentsToken() + '/');
  });

  it('stamps CSS the same way', () => {
    const src = srcOf(component('font-mfizz', 'css/font-mfizz.css'));
    expect(src).toMatch(/^\/cache-prefix-/);
  });

  it('leaves an absolute component host alone', () => {
    // When config.app.components[name] is a full URL the asset is served by
    // someone else entirely; prefixing it would corrupt the URL.
    const config = require('config');
    const saved = config.app.components['ace-builds'];
    config.app.components['ace-builds'] = 'https://cdn.example.com/ace/1.4.14';
    try {
      const src = srcOf(component('ace-builds', 'src-min-noconflict/ace.js'));
      expect(src).toBe('https://cdn.example.com/ace/1.4.14/src-min-noconflict/ace.js');
    } finally {
      config.app.components['ace-builds'] = saved;
    }
  });
});
