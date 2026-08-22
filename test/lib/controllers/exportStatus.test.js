// Production 500 on uindy: GET /api/exports/:id threw
// "created.toISOString is not a function" because Firestore returned `created`
// as a Number (the timestamps plugin wrote Date.now() into a { type: Date }).
//
// WHY THIS IS A UNIT TEST. An API-level test against the Mongo harness CANNOT
// reproduce this: Mongoose casts on read as well as on write, so a number
// forced into the collection comes back as a Date and the handler never sees
// the broken shape. A first draft did exactly that and passed with the fix
// reverted — proving nothing. Stubbing the model is what makes the production
// shape reachable.
const users  = require('../../../lib/controllers/users');
const Export = require('../../../lib/models/export');

const EPOCH = 1787416852246;   // the value actually found in the uindy document

function fakeReply() {
  const reply = () => ({ redirect: () => {} });
  return reply;
}

function fakeRequest(userId) {
  const captured = {};
  return {
    captured,
    user   : { id: userId },
    params : { exportId: 'VpBqyyyJPpB2BPgZOrcY' },
    success: (payload) => { captured.success = payload; },
    fail   : (payload) => { captured.fail = payload; },
  };
}

function record(overrides) {
  return Object.assign({
    _id      : { toString: () => 'VpBqyyyJPpB2BPgZOrcY' },
    _owner   : { toString: () => 'user-1' },
    status   : 'pending',
    created  : EPOCH,          // Number, exactly as Firestore returned it
    expiresAt: undefined,
    progress : { total: 0, processed: 0, failed: 0 },
  }, overrides || {});
}

describe('getExportStatus with a Firestore-shaped record', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves an ISO string when created is an epoch number', async () => {
    vi.spyOn(Export, 'findById').mockImplementation((id, cb) => cb(null, record()));

    const request = fakeRequest('user-1');
    await users.getExportStatus(request, fakeReply());

    expect(request.captured.fail, 'must not fail the request').toBeUndefined();
    expect(request.captured.success).toBeTruthy();
    expect(request.captured.success.data.created).toBe(new Date(EPOCH).toISOString());
  });

  it('reports not-downloadable rather than throwing when expiresAt is missing', async () => {
    vi.spyOn(Export, 'findById').mockImplementation((id, cb) =>
      cb(null, record({ status: 'completed', progress: { total: 3, processed: 3, failed: 0 } })));

    const request = fakeRequest('user-1');
    await users.getExportStatus(request, fakeReply());

    expect(request.captured.success.data.downloadAvailable).toBe(false);
    expect(request.captured.success.data.downloadUrl).toBeNull();
    expect(request.captured.success.data.expiresAt).toBeNull();
  });
});
