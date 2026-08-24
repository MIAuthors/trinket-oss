// The AGS "needs grading" notify silently no-ops on the Firestore backend.
//
// Found live (Canvas rehearsal, 2026-08-24): a student's submission saved with
// every field correct, yet Canvas never received the score call and SpeedGrader
// said "no students are gradable". Cause: the controller builds the submission
// with `_creator: request.user` (the DOCUMENT), and the Firestore model layer —
// unlike Mongoose's ObjectId casting — keeps the object in memory, coercing to
// an id string only at write time. notify() then did `_creator.toString()` →
// "[object Object]" → identity lookup found nothing → best-effort null, no log.
const ltiAgs          = require('../../../lib/util/ltiAgs');
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');
const LtiPlatform     = require('../../../lib/models/ltiPlatform');
const LtiUserIdentity = require('../../../lib/models/ltiUserIdentity');
const notify          = require('../../../lib/util/ltiNotifySubmission');

describe('ltiNotifySubmission with a Firestore-shaped submission', () => {
  let identityQueries, posted;
  beforeEach(() => {
    identityQueries = [];
    posted = [];
    vi.spyOn(LtiResourceLink, 'findAssignmentLink').mockImplementation((c, m, cb) =>
      cb(null, { platformId: 'p1', agsLineItemUrl: 'https://lms/api/lti/courses/5/line_items/5' }));
    vi.spyOn(LtiPlatform, 'findById').mockImplementation((id, cb) =>
      cb(null, { issuer: 'https://lms.example' }));
    vi.spyOn(LtiUserIdentity, 'findByUserAndIss').mockImplementation((userId, iss, cb) => {
      identityQueries.push(userId);
      cb(null, userId === 'user-1' ? { sub: 'sub-1' } : null);
    });
    vi.spyOn(ltiAgs, 'postSubmission').mockImplementation((platform, url, opts) => {
      posted.push(opts); return Promise.resolve({});
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function submissionWith(creator) {
    return { _creator: creator, courseId: 'c1', materialId: 'm1', id: 's1',
             submittedOn: new Date() };
  }

  it('resolves the creator to their ID when _creator is the user DOCUMENT (Firestore shape)', async () => {
    // A doc-like object: has _id and save(), exactly what the Firestore model
    // layer keeps in memory after the controller assigns request.user.
    const userDoc = { _id: 'user-1', id: 'user-1', save: () => {}, username: 'sam' };
    await notify.notify(submissionWith(userDoc));
    expect(identityQueries).toEqual(['user-1']);
    expect(posted.length, 'the AGS call must fire').toBe(1);
    expect(posted[0].userId).toBe('sub-1');
  });

  it('still works when _creator is already an id string (Mongoose shape)', async () => {
    await notify.notify(submissionWith('user-1'));
    expect(identityQueries).toEqual(['user-1']);
    expect(posted.length).toBe(1);
  });

  it('never queries for the [object Object] junk string', async () => {
    await notify.notify(submissionWith({ some: 'object', save: () => {} , _id: 'user-1'}));
    expect(identityQueries.some((q) => String(q).includes('object Object'))).toBe(false);
  });
});
