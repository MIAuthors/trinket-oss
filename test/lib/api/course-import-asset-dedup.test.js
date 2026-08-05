'use strict';

// Asset re-host dedup (integration). The importer uploads each referenced asset's
// bytes to a content-addressed storage key (sha1 of the content). A course that
// references two DIFFERENT /api/files/<id> assets whose CONTENTS are identical hashes
// them to the SAME storage key — and the pre-fix code uploads that key once per
// reference (concurrently, via Promise.all). On GCS that races the same object and
// trips a per-object mutation 429, so the ref falls back to a trinket.io URL.
//
// The fix dedups the physical upload per import: each unique content object is PUT
// once; identical-content refs reuse that upload (each still gets its own File record).
// Here we spy on FileUtil._upload and assert the shared content is uploaded exactly once.

const JSZip    = require('jszip');
const config   = require('config');
const flow     = require('../../helpers/flow.cjs');
const FileUtil = require('../../../lib/util/file');

describe('Course import — asset re-host dedup', () => {
  let assetsOrig, uploadSpy;

  beforeEach(() => {
    flow.cookies = {};
    assetsOrig = config.features.assets;
    config.features.assets = true;   // enable the re-host/upload path (default is false)
  });

  afterEach(() => {
    config.features.assets = assetsOrig;
    if (uploadSpy) { uploadSpy.mockRestore(); uploadSpy = null; }
  });

  it('uploads identical-content assets to storage only once', async () => {
    await flow.switchUser('user');

    const uploadedKeys = [];
    uploadSpy = vi.spyOn(FileUtil, '_upload').mockImplementation(function (buffer, container, s3, fileinfo, cb) {
      uploadedKeys.push(fileinfo.name);   // fileinfo.name is the content-addressed s3 key
      cb(null);                            // pretend the upload succeeded
    });

    // Two different asset IDs, byte-identical content → same content hash → same key.
    const SAME = 'IDENTICAL-BYTES-FOR-DEDUP';
    const zip = new JSZip();
    zip.file('course.json', JSON.stringify({
      lessons: [{
        slug: 'lesson-one', name: 'Lesson One', isDraft: false,
        materials: [{ slug: 'page-one', name: 'Page One', type: 'page' }]
      }]
    }));
    zip.file('00-lesson-one/00-page-one.md',
      'A ![](/api/files/aaaaaaaaaaaaaaaaaaaaaaaa/x.txt) B ![](/api/files/bbbbbbbbbbbbbbbbbbbbbbbb/y.txt)');
    zip.file('assets/aaaaaaaaaaaaaaaaaaaaaaaa/x.txt', SAME);
    zip.file('assets/bbbbbbbbbbbbbbbbbbbbbbbb/y.txt', SAME);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const r = await flow.importCourseZip(buf, { name: 'Dedup Course' });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.status).toBe('ok');

    // Both refs share one content object → uploaded exactly once (pre-fix: twice).
    expect(new Set(uploadedKeys).size).toBe(1);   // one unique content key
    expect(uploadedKeys.length).toBe(1);          // uploaded once, not once-per-reference

    // And neither ref fell back to trinket.io.
    expect((r.body.data.warnings || []).join(' ')).not.toContain('could not be re-hosted');
  });
});
