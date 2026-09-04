'use strict';
// The export button must not be offered where an export cannot run.
//
// Same contract as canImport (#6) and canConnectLms (#197): a control that
// cannot work should say so before it is pressed, not after. On Cloud Run the
// export worker never registers, so the queue discards the job — the user got a
// spinner that never resolved.
const exportGuard = require('../../../lib/util/exportGuard');

describe('exportGuard.exportsAvailable', () => {
  it('is false when the in-process queue has no handler (the Cloud Run case)', () => {
    expect(exportGuard.exportsAvailable({ hasHandlers: () => false })).toBe(false);
  });

  it('is true when a handler is registered (a worker process)', () => {
    expect(exportGuard.exportsAvailable({ hasHandlers: () => true })).toBe(true);
  });

  it('is true for a queue that cannot report handlers (Bull/Redis)', () => {
    // Deliberate: redis PERSISTS jobs, so a separate worker may pick them up
    // later. "No handler in THIS process" is not a failure there — the same
    // reasoning failIfNoWorker already documents.
    expect(exportGuard.exportsAvailable({})).toBe(true);
  });

  it('is false for a missing queue rather than throwing', () => {
    expect(exportGuard.exportsAvailable(null)).toBe(false);
  });
});
