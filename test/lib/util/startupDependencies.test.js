'use strict';

// Guard for a failure mode that reads as a mystery when it happens: several
// deploys keep node_modules in a Docker volume while bind-mounting the source,
// so rebuilding the image leaves the modules a release behind. A commit that
// adds a dependency then crash-loops with `Cannot find module 'x'` while the
// build log looks clean. The startup check names the missing packages instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkDependencies } = require('../../../lib/util/startup-check');

function fixture(declared, installed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-'));
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: declared }));
  installed.forEach(function(name) {
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
  });
  return root;
}

describe('startup dependency check', function() {
  it('is silent when everything declared is installed', function() {
    const root = fixture({ jsdom: '^24.0.0', marked: '^12.0.0' }, ['jsdom', 'marked']);
    expect(checkDependencies(root).missing).toEqual([]);
  });

  // The real case: jsdom arrived with the markdown engine bridge and the
  // volume still held the previous install.
  it('names a dependency that is declared but not installed', function() {
    const root = fixture({ jsdom: '^24.0.0', marked: '^12.0.0' }, ['marked']);
    expect(checkDependencies(root).missing).toEqual(['jsdom']);
  });

  it('reports every missing package, not just the first', function() {
    const root = fixture({ a: '1', b: '1', c: '1' }, ['b']);
    expect(checkDependencies(root).missing.sort()).toEqual(['a', 'c']);
  });

  // devDependencies are absent from production images by design, so flagging
  // them would cry wolf on every prod boot.
  it('ignores devDependencies', function() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-'));
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: {}, devDependencies: { vitest: '^1' } }));
    expect(checkDependencies(root).missing).toEqual([]);
  });

  it('degrades quietly when package.json cannot be read', function() {
    const result = checkDependencies(path.join(os.tmpdir(), 'definitely-not-here'));
    expect(result.missing).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
