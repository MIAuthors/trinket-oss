'use strict';

// Bulk "Download All Trinkets" export must not include soft-deleted trinkets.
// Regression for Nathaniel's report: he deleted everything down to 35 trinkets
// but the export produced 341 — every trinket he'd ever owned, deleted or not.
// The archive query (lib/workers/exports.js) omitted the `deletedAt: null`
// filter that every other trinket query in the codebase carries.

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const JSZip    = require('jszip');
const mongoose = require('mongoose');
const flow     = require('../../helpers/flow.cjs');

// Required lazily inside the test: the worker's require chain (queues, models,
// aws, mailer) must not load until vitest-setup has booted the app + config.
let createExportArchive;

beforeEach(() => { flow.cookies = {}; });

function ownerId(email) {
  return new Promise((res, rej) =>
    User.findByLogin(email, (e, d) => (e ? rej(e) : res(d._id || d.id))));
}

async function makeTrinket() {
  await flow.createTrinket();
  return flow.lastResponse.body.data.id;
}

describe('bulk export — soft-deleted trinkets', () => {
  it('excludes soft-deleted trinkets from the archive and manifest', async () => {
    ({ createExportArchive } = require('../../../lib/workers/exports'));

    await flow.switchUser('user');
    await makeTrinket();
    await makeTrinket();
    const deleted = await makeTrinket();

    // Soft-delete one (same path the UI uses: deletedAt is set, row survives).
    const del = await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [deleted] });
    expect(del.statusCode).toBe(200);

    const uid = await ownerId('test@dummy.com');
    const tmp = path.join(os.tmpdir(), 'trinket-export-test-' + process.pid + '.zip');

    await createExportArchive(String(uid), new mongoose.Types.ObjectId(), tmp);

    const zip      = await JSZip.loadAsync(fs.readFileSync(tmp));
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    fs.unlinkSync(tmp);

    // Only the two live trinkets should be archived — not the soft-deleted one.
    expect(manifest.totalTrinkets).toBe(2);
    expect(manifest.trinkets).toHaveLength(2);
    expect(manifest.failedTrinkets).toBe(0);
  });
});
