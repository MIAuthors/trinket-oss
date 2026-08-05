'use strict';
// Lazily required in beforeAll (not at module top): lib/workers/exports.js
// pulls in config/app.config -> routes -> controllers -> @hapi/hapi. The
// global test setup (test/helpers/vitest-setup.cjs) boots app.js and applies
// required config fixups (redis disabled + mocked, session secret, etc.)
// inside its own beforeAll. A top-level require here would run at test-file
// collection time, BEFORE that setup runs, and hits real Redis + a
// hapi/@hapi-validate version-skew crash that only happens on that early,
// unconfigured path.
let addTrinketToArchive;
beforeAll(() => {
  ({ addTrinketToArchive } = require('../../../lib/workers/exports'));
});

function fakeArchive() {
  const names = [];
  return { names, append: (_c, opts) => names.push(opts.name) };
}
const trinket = { shortCode: 'abc123', name: 'My Sim', lang: 'python3', code: 'print(1)', assets: [], settings: {} };

describe('addTrinketToArchive basePath', () => {
  it('uses default <lang>/<name>_<shortCode>/ when no options', async () => {
    const a = fakeArchive();
    await addTrinketToArchive(a, trinket);
    expect(a.names.some(n => n.startsWith('python3/My_Sim_abc123/'))).toBe(true);
  });
  it('honors options.basePath', async () => {
    const a = fakeArchive();
    await addTrinketToArchive(a, trinket, { basePath: 'assignment-1/jane/' });
    expect(a.names.every(n => n.startsWith('assignment-1/jane/'))).toBe(true);
    expect(a.names).toContain('assignment-1/jane/metadata.json');
  });
});
