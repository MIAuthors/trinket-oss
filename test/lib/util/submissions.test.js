'use strict';
const S = require('../../../lib/util/submissions');

describe('submissions util', () => {
  it('picks by state precedence, newest lastUpdated as tiebreak', () => {
    const subs = [
      { state: 'started',  lastUpdated: new Date('2026-01-01') },
      { state: 'submitted', lastUpdated: new Date('2026-01-02') },
      { state: 'submitted', lastUpdated: new Date('2026-01-03') }
    ];
    const cur = S.pickCurrentSubmission(subs);
    expect(cur.state).toBe('submitted');
    expect(cur.lastUpdated).toEqual(new Date('2026-01-03'));
  });

  it('returns null when empty', () => {
    expect(S.pickCurrentSubmission([])).toBeNull();
  });

  it('returns the newest feedback comment only', () => {
    const subs = [{ comments: [
      { commentType: 'feedback', commentText: 'old', commented: new Date('2026-01-01') },
      { commentType: 'student',  commentText: 'ignore', commented: new Date('2026-02-01') },
      { commentType: 'feedback', commentText: 'new', commented: new Date('2026-01-05') }
    ] }];
    expect(S.latestFeedbackComment(subs).commentText).toBe('new');
  });
});
